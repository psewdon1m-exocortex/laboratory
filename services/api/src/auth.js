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

export function createSession(username, secret, generation = 0) {
  const csrf = crypto.randomBytes(24).toString("base64url");
  const payload = encode(JSON.stringify({ sub: username, csrf, generation, exp: Date.now() + SESSION_TTL_MS }));
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

export function authMiddleware(config, security) {
  function session(req) {
    const token = req.cookies?.[SESSION_COOKIE];
    const value = readSession(token, config.adminUsername, config.sessionSecret);
    if (!value || (security && (value.generation !== security.generation() || security.revoked(token)))) return null;
    return value;
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

export function hashAccessKey(key) {
  const salt = crypto.randomBytes(16);
  return `scrypt$${salt.toString("base64url")}$${crypto.scryptSync(key, salt, 64).toString("base64url")}`;
}

export function validAccessVerifier(value) {
  return typeof value === "string" && /^scrypt\$[A-Za-z0-9_-]{22}\$[A-Za-z0-9_-]{86}$/.test(value);
}

export function verifyAccessKey(key, verifier) {
  if (!validAccessVerifier(verifier) || typeof key !== "string" || key.length > 1024) return false;
  const [, salt, expected] = verifier.split("$");
  return safeEqual(crypto.scryptSync(key, Buffer.from(salt, "base64url"), 64).toString("base64url"), expected);
}

export class OperatorSecurity {
  constructor(db, config) {
    this.db = db;
    db.exec(`CREATE TABLE IF NOT EXISTS operator_security (
      id INTEGER PRIMARY KEY CHECK(id=1), access_verifier TEXT NOT NULL,
      generation INTEGER NOT NULL DEFAULT 1);
      CREATE TABLE IF NOT EXISTS revoked_sessions(token_hash TEXT PRIMARY KEY, expires_at INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS revoked_sessions_expiry ON revoked_sessions(expires_at);`);
    if ((config.accessKey || config.adminPassword) && !db.prepare("SELECT 1 FROM operator_security WHERE id=1").get()) {
      db.prepare("INSERT INTO operator_security(id, access_verifier) VALUES(1, ?)").run(hashAccessKey(config.accessKey || config.adminPassword));
    }
  }
  snapshot() { return this.db.prepare("SELECT access_verifier, generation FROM operator_security WHERE id=1").get(); }
  generation() { return this.snapshot()?.generation || 0; }
  verify(key) { return verifyAccessKey(key, this.snapshot()?.access_verifier); }
  rotate(key) {
    if (typeof key !== "string" || key.length < 12 || key.length > 1024) throw Object.assign(new Error("Access Key must contain 12–1024 characters"), { status: 400 });
    this.db.prepare("UPDATE operator_security SET access_verifier=?, generation=generation+1 WHERE id=1").run(hashAccessKey(key));
  }
  revoke(token, expiresAt) {
    this.db.prepare("DELETE FROM revoked_sessions WHERE expires_at<=?").run(Date.now());
    this.db.prepare("INSERT OR IGNORE INTO revoked_sessions(token_hash, expires_at) VALUES(?,?)").run(crypto.createHash("sha256").update(token).digest("hex"), expiresAt);
  }
  revoked(token) { return Boolean(this.db.prepare("SELECT 1 FROM revoked_sessions WHERE token_hash=? AND expires_at>?").get(crypto.createHash("sha256").update(token || "").digest("hex"), Date.now())); }
  restore(value) {
    if (value && (!Number.isSafeInteger(value.generation) || value.generation < 1 || value.generation > 2147483646 || !validAccessVerifier(value.access_verifier))) throw new Error("Invalid backup access verifier");
    const current = this.snapshot();
    if (!current && !value) return;
    if (!current) {
      this.db.prepare("INSERT INTO operator_security(id,access_verifier,generation) VALUES(1,?,?)").run(value.access_verifier, (Number(value.generation) || 0) + 1);
      return;
    }
    this.db.prepare("UPDATE operator_security SET access_verifier=?, generation=? WHERE id=1").run(value?.access_verifier || current.access_verifier, Math.max(current.generation, Number(value?.generation) || 0) + 1);
    this.db.prepare("DELETE FROM revoked_sessions").run();
  }
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
