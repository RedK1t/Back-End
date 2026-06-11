// auth.js — verify a Supabase access token and resolve the authoritative user id.
//
// We never trust a user id sent by the client. Instead we take the Bearer token
// the SPA already holds (Supabase access_token from localStorage) and validate it
// against Supabase's own auth API. The user id returned by Supabase (`user.id`)
// is the only identity we act on, which is what guarantees a user can only ever
// reach their own container.

const SUPABASE_URL = (process.env.SUPABASE_URL || "").replace(/\/+$/, "");
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY || "";

// Small in-memory cache so a 60s heartbeat doesn't hit Supabase every time.
// token -> { userId, expires (ms epoch) }
const tokenCache = new Map();
const CACHE_TTL_MS = 60 * 1000;

function now() {
  return Date.now();
}

async function resolveUserId(token) {
  const cached = tokenCache.get(token);
  if (cached && cached.expires > now()) {
    return cached.userId;
  }

  if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
    throw new Error("SUPABASE_URL / SUPABASE_ANON_KEY are not configured");
  }

  const res = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
    headers: {
      Authorization: `Bearer ${token}`,
      apikey: SUPABASE_ANON_KEY,
    },
  });

  if (!res.ok) {
    return null;
  }

  const user = await res.json();
  if (!user || !user.id) {
    return null;
  }

  tokenCache.set(token, { userId: user.id, expires: now() + CACHE_TTL_MS });
  return user.id;
}

// Express middleware: requires a valid Supabase Bearer token, sets req.userId.
async function requireAuth(req, res, next) {
  try {
    const header = req.headers.authorization || "";
    const match = header.match(/^Bearer\s+(.+)$/i);
    if (!match) {
      return res.status(401).json({ error: "missing_bearer_token" });
    }

    const userId = await resolveUserId(match[1].trim());
    if (!userId) {
      return res.status(401).json({ error: "invalid_token" });
    }

    req.userId = userId;
    next();
  } catch (err) {
    console.error("[auth] verification failed:", err.message);
    res.status(500).json({ error: "auth_verification_failed" });
  }
}

module.exports = { requireAuth, resolveUserId };
