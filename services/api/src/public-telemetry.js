const CONSENT_VALUE = "accepted.2026-09-16.1";
const EVENTS = new Set([
  "page_view",
  "article_open",
  "abstract_open",
  "transcript_open",
  "derived_panel_open",
  "pdf_open",
  "theme_change",
  "consent_accept",
]);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function text(value, maximum) {
  const result = String(value ?? "").normalize("NFC").trim();
  if (result.length > maximum || /[\u0000-\u001f\u007f]/.test(result)) throw Object.assign(new Error("Invalid telemetry field"), { status: 400 });
  return result;
}

function publicPath(value) {
  const result = text(value, 500);
  if (!result.startsWith("/") || result.includes("?") || result.includes("#") || result.startsWith("//")) {
    throw Object.assign(new Error("Invalid telemetry path"), { status: 400 });
  }
  return result;
}

function origin(value) {
  const result = text(value, 300);
  if (!result) return "";
  let parsed;
  try { parsed = new URL(result); } catch { throw Object.assign(new Error("Invalid telemetry referrer"), { status: 400 }); }
  if (!["http:", "https:"].includes(parsed.protocol) || parsed.username || parsed.password || parsed.pathname !== "/" || parsed.search || parsed.hash) {
    throw Object.assign(new Error("Invalid telemetry referrer"), { status: 400 });
  }
  return parsed.origin;
}

export class PublicTelemetry {
  constructor(db, { retentionDays = 30 } = {}) {
    this.db = db;
    this.retentionDays = retentionDays;
    this.lastCleanup = 0;
    this.initialize();
  }

  initialize() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS public_telemetry_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        event_type TEXT NOT NULL,
        occurred_at TEXT NOT NULL,
        received_at TEXT NOT NULL,
        page_path TEXT NOT NULL,
        visitor_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        referrer_origin TEXT,
        language TEXT NOT NULL,
        viewport_class TEXT NOT NULL CHECK(viewport_class IN ('mobile', 'tablet', 'desktop'))
      );
      CREATE INDEX IF NOT EXISTS idx_public_telemetry_received
      ON public_telemetry_events(received_at DESC);
    `);
  }

  collect(input) {
    const event = text(input?.event, 40);
    if (!EVENTS.has(event)) throw Object.assign(new Error("Unknown telemetry event"), { status: 400 });
    const visitorId = text(input?.visitorId, 64);
    const sessionId = text(input?.sessionId, 64);
    if (!UUID.test(visitorId) || !UUID.test(sessionId)) throw Object.assign(new Error("Invalid telemetry identifier"), { status: 400 });
    const occurred = new Date(String(input?.occurredAt || ""));
    if (!Number.isFinite(occurred.getTime()) || Math.abs(Date.now() - occurred.getTime()) > 24 * 60 * 60 * 1000) {
      throw Object.assign(new Error("Invalid telemetry timestamp"), { status: 400 });
    }
    const language = text(input?.language || "en", 35) || "en";
    const viewport = text(input?.viewportClass, 10);
    if (!["mobile", "tablet", "desktop"].includes(viewport)) throw Object.assign(new Error("Invalid telemetry viewport"), { status: 400 });
    const receivedAt = new Date().toISOString();
    this.db.prepare(`
      INSERT INTO public_telemetry_events(
        event_type, occurred_at, received_at, page_path, visitor_id, session_id,
        referrer_origin, language, viewport_class
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(event, occurred.toISOString(), receivedAt, publicPath(input?.path), visitorId, sessionId,
      origin(input?.referrerOrigin), language, viewport);
    this.cleanup();
  }

  cleanup() {
    if (Date.now() - this.lastCleanup < 60 * 60 * 1000) return;
    this.lastCleanup = Date.now();
    const cutoff = new Date(Date.now() - this.retentionDays * 86400 * 1000).toISOString();
    this.db.prepare("DELETE FROM public_telemetry_events WHERE received_at < ?").run(cutoff);
  }

  status() {
    const row = this.db.prepare("SELECT COUNT(*) AS count, MAX(received_at) AS latest FROM public_telemetry_events").get();
    return { collectionEnabled: true, processingEnabled: false, retentionDays: this.retentionDays, storedEvents: row.count, latestEventAt: row.latest || null };
  }
}

export function hasTelemetryConsent(req) {
  return req.cookies?.laboratory_consent === CONSENT_VALUE;
}
