import crypto from "node:crypto";

const SESSION_COOKIE = "laboratory_session";
const SESSION_TTL_MS = 12 * 60 * 60 * 1000;

function encode(value) {
  return Buffer.from(value).toString("base64url");
}
function sign(value, secret) {
  return crypto.createHmac("sha256", secret).update(value).digest("base64url");
}

function safeEqual(left, right) {
  const a = Buffer.from(String(left));
  const b = Buffer.from(String(right));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

export function createSession(username, secret) {
  const csrf = crypto.randomBytes(24).toString("base64url");
  const payload = encode(JSON.stringify({ sub: username, csrf, exp: Date.now() + SESSION_TTL_MS }));
  return { token: `${payload}.${sign(payload, secret)}`, csrf };
}

export function readSession(token, username, secret) {
  if (!token) return null;
  const [payload, signature, extra] = token.split(".");
  if (!payload || !signature || extra || !safeEqual(signature, sign(payload, secret))) return null;
  try {
    const value = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    if (value.sub !== username || !value.csrf || !value.exp || Date.now() >= value.exp) return null;
    return value;
  } catch {
    return null;
  }
}

export function authMiddleware(config) {
  function session(req) {
    return readSession(req.cookies?.[SESSION_COOKIE], config.adminUsername, config.sessionSecret);
  }
  function requireAdmin(req, res, next) {
    const value = session(req);
    if (!value) return res.status(401).json({ error: "Unauthorized" });
    req.adminSession = value;
    next();
  }
  function requireMutation(req, res, next) {
    const value = session(req);
    if (!value) return res.status(401).json({ error: "Unauthorized" });
    if (!safeEqual(req.get("X-CSRF-Token") ?? "", value.csrf)) {
      return res.status(403).json({ error: "Invalid CSRF token" });
    }
    req.adminSession = value;
    next();
  }
  return { session, requireAdmin, requireMutation };
}

export function setSessionCookie(res, token, config) {
  res.cookie(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: "strict",
    secure: config.cookieSecure,
    maxAge: SESSION_TTL_MS,
    path: "/",
  });
}

export function clearSessionCookie(res, config) {
  res.clearCookie(SESSION_COOKIE, {
    httpOnly: true,
    sameSite: "strict",
    secure: config.cookieSecure,
    path: "/",
  });
}

export function credentialsMatch(username, password, config) {
  return safeEqual(username, config.adminUsername) && safeEqual(password, config.adminPassword);
}

export class LoginLimiter {
  constructor() {
    this.attempts = new Map();
  }

  check(key) {
    const now = Date.now();
    const current = this.attempts.get(key);
    if (!current || now - current.startedAt > 15 * 60 * 1000) {
      this.attempts.set(key, { count: 1, startedAt: now });
      return;
    }
    current.count += 1;
    if (current.count > 8) {
      const error = new Error("Too many login attempts. Try again later.");
      error.status = 429;
      throw error;
    }
  }

  clear(key) {
    this.attempts.delete(key);
  }
}
