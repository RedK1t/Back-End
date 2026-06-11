// ticket.js — short-lived, HMAC-signed capability tokens that bind a gateway
// connection to a specific user.
//
// The data-plane gateway never trusts a port or a client-supplied container id.
// Instead, every connection must present a ticket (interceptor WebSocket, in the
// URL) or a cookie (noVNC same-origin requests). Both are signed with a server
// secret, so a user cannot forge access to anyone else's container.

const crypto = require("crypto");

const SECRET = process.env.GATEWAY_SECRET || "";
const TICKET_TTL_MS = parseInt(process.env.TICKET_TTL_MS || "21600000", 10); // 6h

if (!SECRET) {
  console.warn(
    "[ticket] GATEWAY_SECRET is empty — set it in Back-End/.env for a secure gateway",
  );
}

function b64url(buf) {
  return Buffer.from(buf)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function sign(payloadB64) {
  return b64url(
    crypto.createHmac("sha256", SECRET).update(payloadB64).digest(),
  );
}

// Build a signed token: "<payload>.<sig>" where payload = { uid, exp }.
function makeToken(userId, ttlMs) {
  const payload = { uid: String(userId), exp: Date.now() + ttlMs };
  const payloadB64 = b64url(JSON.stringify(payload));
  return `${payloadB64}.${sign(payloadB64)}`;
}

// Verify a signed token; return userId if valid and unexpired, else null.
function verifyToken(token) {
  if (!token || typeof token !== "string") return null;
  const dot = token.lastIndexOf(".");
  if (dot < 0) return null;
  const payloadB64 = token.slice(0, dot);
  const sig = token.slice(dot + 1);

  // Constant-time signature comparison.
  const expected = sign(payloadB64);
  if (
    sig.length !== expected.length ||
    !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))
  ) {
    return null;
  }

  let payload;
  try {
    payload = JSON.parse(
      Buffer.from(payloadB64.replace(/-/g, "+").replace(/_/g, "/"), "base64"),
    );
  } catch {
    return null;
  }
  if (!payload || !payload.uid || !payload.exp || payload.exp < Date.now()) {
    return null;
  }
  return payload.uid;
}

// Ticket: used in URLs (VNC tab + interceptor WS). Cookie: same scheme, set after a
// valid ticket so noVNC's same-origin subresources/websockify stay authorized.
const mintTicket = (userId) => makeToken(userId, TICKET_TTL_MS);
const verifyTicket = (t) => verifyToken(t);
const signCookie = (userId) => makeToken(userId, TICKET_TTL_MS);
const verifyCookie = (c) => verifyToken(c);

module.exports = { mintTicket, verifyTicket, signCookie, verifyCookie };
