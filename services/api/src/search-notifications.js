import crypto from "node:crypto";
import { GoogleAuth } from "google-auth-library";

const GOOGLE_INDEXING_ENDPOINT = "https://indexing.googleapis.com/v3/urlNotifications:publish";

function experimentBucket(value) {
  return Number.parseInt(crypto.createHash("sha256").update(String(value)).digest("hex").slice(0, 8), 16) % 100;
}

export class SearchNotificationRuntime {
  constructor(config, library, register) {
    this.config = config;
    this.library = library;
    this.db = library.db;
    this.register = register;
    this.timer = null;
    this.running = false;
    this.auth = config.googleIndexingExperimentEnabled
      ? new GoogleAuth({
        scopes: ["https://www.googleapis.com/auth/indexing"],
        ...(config.googleServiceAccountCredentials ? { credentials: config.googleServiceAccountCredentials } : {}),
      })
      : null;
  }

  start() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS search_notification_jobs (
        provider TEXT NOT NULL,
        revision_id INTEGER NOT NULL REFERENCES article_revisions(id) ON DELETE CASCADE,
        status TEXT NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 0,
        last_error TEXT,
        next_attempt_at TEXT,
        accepted_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY(provider, revision_id)
      );
      CREATE TABLE IF NOT EXISTS search_notification_state (
        provider TEXT PRIMARY KEY,
        initialized_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS search_notification_url_jobs (
        provider TEXT NOT NULL,
        slug TEXT NOT NULL,
        event_at TEXT NOT NULL,
        status TEXT NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 0,
        last_error TEXT,
        next_attempt_at TEXT,
        accepted_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY(provider, slug, event_at)
      );
    `);
    if (!this.db.prepare("PRAGMA table_info(search_notification_jobs)").all().some((column) => column.name === "next_attempt_at")) {
      this.db.exec("ALTER TABLE search_notification_jobs ADD COLUMN next_attempt_at TEXT");
    }
    this.initializeProvider("indexnow", this.config.indexNowEnabled);
    this.initializeProvider("google-indexing-experiment", this.config.googleIndexingExperimentEnabled);
    this.enqueueNew();
    this.enqueueUrlChanges();
    if (!this.config.indexNowEnabled && !this.config.googleIndexingExperimentEnabled) return;
    setImmediate(() => this.tick());
    this.timer = setInterval(() => this.tick(), this.config.searchNotificationIntervalSeconds * 1000);
    this.timer.unref();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
  }

  publicUrl() {
    return String(this.register.state.publicUrl || this.config.publicUrl || "").replace(/\/$/, "");
  }

  initializeProvider(provider, enabled) {
    if (!enabled || this.db.prepare("SELECT 1 FROM search_notification_state WHERE provider = ?").get(provider)) return;
    const now = new Date().toISOString();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.prepare(`
        INSERT OR IGNORE INTO search_notification_jobs(provider, revision_id, status, attempts, created_at, updated_at)
        SELECT ?, published_revision_id, 'baseline', 0, ?, ? FROM library_articles
        WHERE source_status = 'published' AND published_revision_id IS NOT NULL
      `).run(provider, now, now);
      this.db.prepare("INSERT INTO search_notification_state(provider, initialized_at) VALUES (?, ?)").run(provider, now);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  enqueueNew() {
    const now = new Date().toISOString();
    if (this.config.indexNowEnabled) {
      this.db.prepare(`
        INSERT OR IGNORE INTO search_notification_jobs(provider, revision_id, status, attempts, created_at, updated_at)
        SELECT 'indexnow', published_revision_id, 'pending', 0, ?, ? FROM library_articles
        WHERE source_status = 'published' AND published_revision_id IS NOT NULL
      `).run(now, now);
    }
    if (this.config.googleIndexingExperimentEnabled) {
      const rows = this.db.prepare(`
        SELECT a.published_revision_id AS revision_id, a.internal_id
        FROM library_articles a
        LEFT JOIN search_notification_jobs j
          ON j.provider = 'google-indexing-experiment' AND j.revision_id = a.published_revision_id
        WHERE a.source_status = 'published' AND a.published_revision_id IS NOT NULL AND j.revision_id IS NULL
      `).all();
      const insert = this.db.prepare("INSERT INTO search_notification_jobs(provider, revision_id, status, attempts, created_at, updated_at) VALUES ('google-indexing-experiment', ?, ?, 0, ?, ?)");
      for (const row of rows) {
        const selected = experimentBucket(row.internal_id) < this.config.googleIndexingExperimentSamplePercent;
        insert.run(row.revision_id, selected ? "pending" : "control", now, now);
      }
    }
  }

  enqueueUrlChanges() {
    if (!this.config.indexNowEnabled) return;
    const now = new Date().toISOString();
    this.db.prepare(`
      INSERT OR IGNORE INTO search_notification_url_jobs(provider, slug, event_at, status, attempts, created_at, updated_at)
      SELECT 'indexnow', slug, removed_at, 'pending', 0, ?, ? FROM gone_urls
    `).run(now, now);
  }

  status() {
    const rows = this.db.prepare("SELECT provider, status, COUNT(*) AS count FROM search_notification_jobs GROUP BY provider, status").all();
    const providers = {};
    for (const row of rows) {
      providers[row.provider] ||= {};
      providers[row.provider][row.status] = row.count;
    }
    const urlRows = this.db.prepare("SELECT provider, status, COUNT(*) AS count FROM search_notification_url_jobs GROUP BY provider, status").all();
    const urlJobs = {};
    for (const row of urlRows) {
      urlJobs[row.provider] ||= {};
      urlJobs[row.provider][row.status] = row.count;
    }
    return {
      publicUrlConfigured: Boolean(this.publicUrl()),
      indexNow: { enabled: this.config.indexNowEnabled, jobs: providers.indexnow || {}, urlChanges: urlJobs.indexnow || {} },
      googleIndexingExperiment: {
        enabled: this.config.googleIndexingExperimentEnabled,
        endDate: this.config.googleIndexingExperimentEndDate || null,
        samplePercent: this.config.googleIndexingExperimentSamplePercent,
        jobs: providers["google-indexing-experiment"] || {},
      },
    };
  }

  articleForJob(provider) {
    return this.db.prepare(`
      SELECT j.provider, j.revision_id, j.attempts, a.slug
      FROM search_notification_jobs j
      JOIN library_articles a ON a.published_revision_id = j.revision_id AND a.source_status = 'published'
      WHERE j.provider = ? AND j.status IN ('pending', 'failed') AND j.attempts < 3
        AND (j.next_attempt_at IS NULL OR j.next_attempt_at <= ?)
      ORDER BY j.created_at, j.revision_id
      LIMIT 1
    `).get(provider, new Date().toISOString());
  }

  urlJob(provider) {
    return this.db.prepare(`
      SELECT * FROM search_notification_url_jobs
      WHERE provider = ? AND status IN ('pending', 'failed') AND attempts < 3
        AND (next_attempt_at IS NULL OR next_attempt_at <= ?)
      ORDER BY created_at, event_at LIMIT 1
    `).get(provider, new Date().toISOString());
  }

  articleUrl(slug) {
    return new URL(`/journal/${encodeURIComponent(slug)}`, `${this.publicUrl()}/`).toString();
  }

  mark(job, status, error = null) {
    const now = new Date().toISOString();
    const retryAt = status === "failed" ? new Date(Date.now() + Math.min(60, 2 ** (job.attempts + 1)) * 60_000).toISOString() : null;
    this.db.prepare(`
      UPDATE search_notification_jobs SET status = ?, attempts = attempts + 1, last_error = ?,
        next_attempt_at = ?, accepted_at = CASE WHEN ? = 'accepted' THEN ? ELSE accepted_at END, updated_at = ?
      WHERE provider = ? AND revision_id = ?
    `).run(status, error ? String(error.message || error).slice(0, 2_000) : null, retryAt, status, now, now, job.provider, job.revision_id);
  }

  markUrl(job, status, error = null) {
    const now = new Date().toISOString();
    const retryAt = status === "failed" ? new Date(Date.now() + Math.min(60, 2 ** (job.attempts + 1)) * 60_000).toISOString() : null;
    this.db.prepare(`
      UPDATE search_notification_url_jobs SET status = ?, attempts = attempts + 1, last_error = ?, next_attempt_at = ?,
        accepted_at = CASE WHEN ? = 'accepted' THEN ? ELSE accepted_at END, updated_at = ?
      WHERE provider = ? AND slug = ? AND event_at = ?
    `).run(status, error ? String(error.message || error).slice(0, 2_000) : null, retryAt,
      status, now, now, job.provider, job.slug, job.event_at);
  }

  async sendIndexNow(job) {
    const url = this.articleUrl(job.slug);
    const publicUrl = new URL(this.publicUrl());
    const response = await fetch(this.config.indexNowEndpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json; charset=utf-8" },
      body: JSON.stringify({
        host: publicUrl.host,
        key: this.config.indexNowKey,
        keyLocation: new URL(`/${this.config.indexNowKey}.txt`, publicUrl).toString(),
        urlList: [url],
      }),
      signal: AbortSignal.timeout(this.config.searchNotificationTimeoutMs),
    });
    if (![200, 202].includes(response.status)) throw new Error(`IndexNow returned HTTP ${response.status}`);
  }

  async sendIndexNowUrlJob(job) {
    const url = this.articleUrl(job.slug);
    const publicUrl = new URL(this.publicUrl());
    const response = await fetch(this.config.indexNowEndpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json; charset=utf-8" },
      body: JSON.stringify({
        host: publicUrl.host,
        key: this.config.indexNowKey,
        keyLocation: new URL(`/${this.config.indexNowKey}.txt`, publicUrl).toString(),
        urlList: [url],
      }),
      signal: AbortSignal.timeout(this.config.searchNotificationTimeoutMs),
    });
    if (![200, 202].includes(response.status)) throw new Error(`IndexNow returned HTTP ${response.status}`);
  }

  googleDailyAccepted() {
    return this.db.prepare(`
      SELECT COUNT(*) AS count FROM search_notification_jobs
      WHERE provider = 'google-indexing-experiment' AND status = 'accepted' AND accepted_at >= ?
    `).get(new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()).count;
  }

  googleExperimentActive() {
    return this.config.googleIndexingExperimentEnabled
      && this.config.googleIndexingExperimentEndDate
      && Date.now() <= new Date(`${this.config.googleIndexingExperimentEndDate}T23:59:59.999Z`).getTime();
  }

  async sendGoogleExperiment(job) {
    const client = await this.auth.getClient();
    await client.request({
      url: GOOGLE_INDEXING_ENDPOINT,
      method: "POST",
      data: { url: this.articleUrl(job.slug), type: "URL_UPDATED" },
      timeout: this.config.searchNotificationTimeoutMs,
    });
  }

  async tick() {
    if (this.running || this.library.restoreInProgress || !this.publicUrl()) return;
    const restoreEpoch = this.library.restoreEpoch || 0;
    this.running = true;
    try {
      this.enqueueNew();
      this.enqueueUrlChanges();
      if (this.config.indexNowEnabled) {
        const job = this.articleForJob("indexnow");
        if (job) {
          try { await this.sendIndexNow(job); if ((this.library.restoreEpoch || 0) === restoreEpoch) this.mark(job, "accepted"); }
          catch (error) { if ((this.library.restoreEpoch || 0) === restoreEpoch) this.mark(job, "failed", error); }
        }
        const urlJob = this.urlJob("indexnow");
        if (urlJob) {
          try { await this.sendIndexNowUrlJob(urlJob); if ((this.library.restoreEpoch || 0) === restoreEpoch) this.markUrl(urlJob, "accepted"); }
          catch (error) { if ((this.library.restoreEpoch || 0) === restoreEpoch) this.markUrl(urlJob, "failed", error); }
        }
      }
      if (this.googleExperimentActive() && this.googleDailyAccepted() < this.config.googleIndexingExperimentMaxUrlsPerDay) {
        const job = this.articleForJob("google-indexing-experiment");
        if (job) {
          try { await this.sendGoogleExperiment(job); if ((this.library.restoreEpoch || 0) === restoreEpoch) this.mark(job, "accepted"); }
          catch (error) { if ((this.library.restoreEpoch || 0) === restoreEpoch) this.mark(job, "failed", error); }
        }
      }
    } finally {
      this.running = false;
    }
  }
}
