// server.js — RedKit per-user browser-container orchestrator + authenticated gateway.
//
// Two listeners in one process:
//   - Control API (PORT, default 3008): create/stop/heartbeat/status, Supabase-auth'd.
//   - Data gateway (GATEWAY_PORT, default 3009): the ONLY way to reach a container.
//     Containers no longer publish host ports; the gateway proxies noVNC (6080) and
//     the interceptor proxy (5050) to each user's container, authorizing every
//     connection with an HMAC-signed ticket (interceptor WS, in the URL) or a cookie
//     (noVNC same-origin requests). A user can therefore only ever reach their own
//     container — identity is derived from the signed credential, never from a port.

require("dotenv").config();

const http = require("http");
const express = require("express");
const cors = require("cors");
const httpProxy = require("http-proxy");

const { requireAuth } = require("./auth");
const dockerMgr = require("./docker");
const { mintTicket, verifyTicket, signCookie, verifyCookie } = require("./ticket");

const PORT = parseInt(process.env.PORT || "3008", 10);
const GATEWAY_PORT = parseInt(process.env.GATEWAY_PORT || "3009", 10);
const IDLE_TIMEOUT_MS = parseInt(process.env.IDLE_TIMEOUT_MS || "300000", 10);
const TICKET_TTL_MS = parseInt(process.env.TICKET_TTL_MS || "21600000", 10);
const PUBLIC_HOST = process.env.PUBLIC_HOST || "localhost";
const VNC_PORT = process.env.VNC_CONTAINER_PORT || "6080";
const PROXY_PORT = process.env.PROXY_CONTAINER_PORT || "5050";

// ---- idle / session manager ----------------------------------------------
// userId -> { ip, lastActivity, timer }
const sessions = new Map();

function clearSession(userId) {
  const s = sessions.get(userId);
  if (s && s.timer) clearTimeout(s.timer);
  sessions.delete(userId);
}

// (Re)arm the idle timer for a user. Each open/heartbeat/gateway-connection refreshes it.
function resetIdle(userId, ip) {
  const existing = sessions.get(userId);
  if (existing && existing.timer) clearTimeout(existing.timer);

  const timer = setTimeout(async () => {
    try {
      await dockerMgr.stop(userId);
      console.log(`[idle] stopped container for user ${userId}`);
    } catch (err) {
      console.error(`[idle] failed to stop ${userId}:`, err.message);
    } finally {
      clearSession(userId);
    }
  }, IDLE_TIMEOUT_MS);

  if (typeof timer.unref === "function") timer.unref();

  sessions.set(userId, {
    ip: ip || (existing && existing.ip) || null,
    lastActivity: Date.now(),
    timer,
  });
}

function buildUrls(userId) {
  const ticket = mintTicket(userId);
  return {
    vncUrl: `http://${PUBLIC_HOST}:${GATEWAY_PORT}/vnc.html?ticket=${ticket}`,
    proxyWsUrl: `ws://${PUBLIC_HOST}:${GATEWAY_PORT}/ws?ticket=${ticket}`,
  };
}

// ---- control API (3008) ---------------------------------------------------
const app = express();
app.use(cors());
app.use(express.json());

app.get("/health", (_req, res) => res.json({ ok: true }));

app.post("/session/open", requireAuth, async (req, res) => {
  try {
    const { ip } = await dockerMgr.ensureRunning(req.userId);
    resetIdle(req.userId, ip);
    res.json({ userId: req.userId, ...buildUrls(req.userId) });
  } catch (err) {
    console.error("[open] failed:", err.message);
    res.status(500).json({ error: "failed_to_open_session", detail: err.message });
  }
});

app.post("/session/heartbeat", requireAuth, (req, res) => {
  const s = sessions.get(req.userId);
  if (!s) {
    return res.status(410).json({ error: "no_active_session" });
  }
  resetIdle(req.userId, s.ip);
  res.json({ ok: true });
});

app.post("/session/stop", requireAuth, async (req, res) => {
  try {
    await dockerMgr.stop(req.userId);
    clearSession(req.userId);
    res.json({ ok: true });
  } catch (err) {
    console.error("[stop] failed:", err.message);
    res.status(500).json({ error: "failed_to_stop_session", detail: err.message });
  }
});

app.get("/session/status", requireAuth, async (req, res) => {
  const s = sessions.get(req.userId);
  if (s && s.ip) {
    // "running" = container exists; "ready" = its proxy is actually accepting
    // connections. The frontend polls this to drive connection-progress UI and only
    // connects the interceptor WebSocket once ready (avoids a premature failed connect).
    const ready = await dockerMgr.probeReachable(s.ip, PROXY_PORT, 1000);
    return res.json({ running: true, ready, ...buildUrls(req.userId) });
  }
  res.json({ running: false, ready: false });
});

// ---- data gateway (3009) --------------------------------------------------
const proxy = httpProxy.createProxyServer({ ws: true, xfwd: true });

// Swallow upstream errors (container still booting / stopped) instead of crashing.
proxy.on("error", (err, _req, resOrSocket) => {
  console.error("[gateway] proxy error:", err.message);
  try {
    if (resOrSocket && typeof resOrSocket.writeHead === "function") {
      resOrSocket.writeHead(502);
      resOrSocket.end("bad gateway");
    } else if (resOrSocket && typeof resOrSocket.destroy === "function") {
      resOrSocket.destroy();
    }
  } catch {
    /* ignore */
  }
});

// If a request authenticated via a fresh ticket, set the cookie so the noVNC tab's
// same-origin subresources/websockify stay authorized without the ticket in the URL.
proxy.on("proxyRes", (proxyRes, req) => {
  if (req._setCookie) {
    const existing = proxyRes.headers["set-cookie"] || [];
    proxyRes.headers["set-cookie"] = [...existing, req._setCookie];
  }
});

function getCookie(req, name) {
  const header = req.headers.cookie;
  if (!header) return null;
  for (const part of header.split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) return decodeURIComponent(v.join("="));
  }
  return null;
}

function bump(userId) {
  const s = sessions.get(userId);
  if (s) resetIdle(userId, s.ip);
}

// Resolve the user for an HTTP request: a valid ?ticket= (and (re)issue the cookie),
// else the existing cookie. Returns { userId, setCookie } or null.
function resolveHttp(req) {
  const u = new URL(req.url, "http://x");
  const ticket = u.searchParams.get("ticket");
  const fromTicket = ticket ? verifyTicket(ticket) : null;
  if (fromTicket) {
    const cookieVal = signCookie(fromTicket);
    const maxAge = Math.floor(TICKET_TTL_MS / 1000);
    return {
      userId: fromTicket,
      setCookie: `redkit_gw=${cookieVal}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${maxAge}`,
    };
  }
  const fromCookie = verifyCookie(getCookie(req, "redkit_gw"));
  return fromCookie ? { userId: fromCookie, setCookie: null } : null;
}

const gatewayServer = http.createServer((req, res) => {
  const resolved = resolveHttp(req);
  if (!resolved) {
    res.writeHead(401);
    return res.end("unauthorized");
  }
  const s = sessions.get(resolved.userId);
  if (!s || !s.ip) {
    res.writeHead(404);
    return res.end("no active session");
  }
  bump(resolved.userId);
  req._setCookie = resolved.setCookie; // consumed in proxyRes
  // All noVNC HTTP paths (/vnc.html, /app/*, /core/*, ...) go to the VNC server.
  proxy.web(req, res, { target: `http://${s.ip}:${VNC_PORT}` });
});

// WebSocket upgrades: /ws -> interceptor (5050, ticket); else -> noVNC (6080, cookie).
gatewayServer.on("upgrade", (req, socket, head) => {
  const u = new URL(req.url, "http://x");
  let userId = null;
  let targetPort = VNC_PORT;

  if (u.pathname === "/ws") {
    userId = verifyTicket(u.searchParams.get("ticket"));
    targetPort = PROXY_PORT;
  } else {
    // /websockify and any other noVNC WS — authorized by the same-origin cookie.
    userId = verifyCookie(getCookie(req, "redkit_gw"));
    targetPort = VNC_PORT;
  }

  const s = userId ? sessions.get(userId) : null;
  if (!userId || !s || !s.ip) {
    socket.destroy();
    return;
  }
  bump(userId);
  proxy.ws(req, socket, head, { target: `http://${s.ip}:${targetPort}` });
});

// ---- startup reconcile ----------------------------------------------------
async function reconcile() {
  try {
    const managed = await dockerMgr.listManaged();
    for (const c of managed) {
      if (c.running && c.userId) {
        const target = await dockerMgr.getTarget(c.userId).catch(() => null);
        resetIdle(c.userId, target && target.ip);
        console.log(`[reconcile] re-armed idle timer for user ${c.userId}`);
      }
    }
  } catch (err) {
    console.error("[reconcile] failed:", err.message);
  }
}

// ---- boot -----------------------------------------------------------------
async function start() {
  try {
    await dockerMgr.ensureNetwork();
  } catch (err) {
    console.error("[boot] ensureNetwork failed:", err.message);
  }

  app.listen(PORT, () => {
    console.log(`RedKit orchestrator (control API) listening on ${PORT}`);
    console.log(`idle timeout: ${IDLE_TIMEOUT_MS}ms, public host: ${PUBLIC_HOST}`);
  });

  gatewayServer.listen(GATEWAY_PORT, () => {
    console.log(`RedKit gateway listening on ${GATEWAY_PORT}`);
  });

  await reconcile();
}

start();
