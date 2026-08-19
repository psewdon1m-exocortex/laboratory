import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { ArticleLibrary } from "./article-library.js";

const DEFAULT_SETTINGS = {
  siteTitle: "Laboratory",
  heroTitle: "Laboratory",
  heroSubtitle: "Independent studies, notes and published work",
  aboutTitle: "about me",
  journalTitle: "journal",
  timeZone: "Europe/Istanbul",
  themeDefault: "system",
  noiseEnabled: "true",
  noiseIntensity: "32",
  noiseGrain: "55",
};

export const UPLOAD_SLOTS = {
  heroImage: { kind: "image", maxBytes: 25 * 1024 * 1024 },
  aboutImage: { kind: "image", maxBytes: 25 * 1024 * 1024 },
  journalImage: { kind: "image", maxBytes: 25 * 1024 * 1024 },
  aboutMarkdown: { kind: "markdown", maxBytes: 2 * 1024 * 1024 },
  // Kept for restoring older backups. The public About page no longer renders this slot.
  aboutPdf: { kind: "pdf", maxBytes: 120 * 1024 * 1024 },
};

function sha256(buffer) {
  return crypto.createHash("sha256").update(buffer).digest("hex");
}

function safeFilename(value) {
  return /^[A-Za-z0-9][A-Za-z0-9._-]{0,159}$/.test(value ?? "");
}

function publicAssetUrl(slot, filename) {
  return filename ? `/api/media/${encodeURIComponent(slot)}/${encodeURIComponent(filename)}` : null;
}

function normalizeSettings(rows) {
  const settings = { ...DEFAULT_SETTINGS };
  for (const row of rows) settings[row.key] = row.value;
  return {
    siteTitle: settings.siteTitle,
    heroTitle: settings.heroTitle,
    heroSubtitle: settings.heroSubtitle,
    pages: {
      about: { title: settings.aboutTitle },
      journal: { title: settings.journalTitle },
    },
    settings: {
      timeZone: settings.timeZone,
      themeDefault: settings.themeDefault,
      noise: {
        enabled: settings.noiseEnabled === "true",
        intensity: Number(settings.noiseIntensity),
        grain: Number(settings.noiseGrain),
      },
    },
  };
}

function validateText(value, name, maximum) {
  const text = String(value ?? "").trim();
  if (!text) throw new Error(`${name} is required`);
  if (text.length > maximum) throw new Error(`${name} must contain at most ${maximum} characters`);
  return text;
}

function validateSettings(input) {
  const noise = input.settings?.noise ?? {};
  const intensity = Number(noise.intensity);
  const grain = Number(noise.grain);
  if (!Number.isFinite(intensity) || intensity < 0 || intensity > 100) {
    throw new Error("Noise intensity must be in [0..100]");
  }
  if (!Number.isFinite(grain) || grain < 0 || grain > 100) {
    throw new Error("Noise grain must be in [0..100]");
  }
  const themeDefault = String(input.settings?.themeDefault ?? "system");
  if (!["system", "dark", "light"].includes(themeDefault)) throw new Error("Invalid default theme");
  const timeZone = validateText(input.settings?.timeZone, "Time zone", 80);
  try { new Intl.DateTimeFormat("en-GB", { timeZone }).format(new Date()); }
  catch { throw new Error("Invalid time zone"); }
  return {
    siteTitle: validateText(input.siteTitle, "Site title", 60),
    heroTitle: validateText(input.heroTitle, "Hero title", 60),
    heroSubtitle: validateText(input.heroSubtitle, "Hero subtitle", 120),
    aboutTitle: validateText(input.pages?.about?.title, "About Me title", 60),
    journalTitle: validateText(input.pages?.journal?.title, "Journal title", 60),
    timeZone,
    themeDefault,
    noiseEnabled: noise.enabled ? "true" : "false",
    noiseIntensity: String(Math.round(intensity)),
    noiseGrain: String(Math.round(grain)),
  };
}

function imageExtension(buffer) {
  if (buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return ".png";
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return ".jpg";
  if (buffer.subarray(0, 6).toString("ascii") === "GIF87a" || buffer.subarray(0, 6).toString("ascii") === "GIF89a") return ".gif";
  if (buffer.subarray(0, 4).toString("ascii") === "RIFF" && buffer.subarray(8, 12).toString("ascii") === "WEBP") return ".webp";
  if (buffer.subarray(4, 12).toString("ascii").includes("ftypavif")) return ".avif";
  return "";
}

export function validateUpload(slot, file) {
  const definition = UPLOAD_SLOTS[slot];
  if (!definition) throw new Error("Unknown upload slot");
  if (!file?.buffer?.length) throw new Error("File is required");
  if (file.buffer.length > definition.maxBytes) throw new Error("File is too large");
  if (definition.kind === "pdf") {
    if (file.buffer.subarray(0, 5).toString("ascii") !== "%PDF-") throw new Error("The uploaded file is not a PDF");
    return { extension: ".pdf", mime: "application/pdf" };
  }
  if (definition.kind === "markdown") {
    let source;
    try { source = new TextDecoder("utf-8", { fatal: true }).decode(file.buffer); }
    catch { throw new Error("The uploaded file is not valid UTF-8 Markdown"); }
    if (source.includes("\0")) throw new Error("The uploaded Markdown contains invalid null bytes");
    return { extension: ".md", mime: "text/markdown" };
  }
  const extension = imageExtension(file.buffer);
  if (!extension) throw new Error("Unsupported image format");
  const mime = extension === ".jpg" ? "image/jpeg" : `image/${extension.slice(1)}`;
  return { extension, mime };
}

async function atomicWrite(filename, buffer) {
  await fs.mkdir(path.dirname(filename), { recursive: true });
  const temporary = path.join(path.dirname(filename), `.${path.basename(filename)}.${process.pid}.tmp`);
  await fs.writeFile(temporary, buffer, { mode: 0o600 });
  await fs.rename(temporary, filename);
}

export class LaboratoryStore {
  static async open(config) {
    const store = new LaboratoryStore(config);
    await store.initialize();
    return store;
  }

  constructor(config) {
    this.config = config;
    this.uploadsDir = path.join(config.dataDir, "uploads");
    this.databasePath = path.join(config.dataDir, "laboratory.sqlite");
    this.db = null;
    this.library = null;
    this.restoreInProgress = false;
    this.restoreEpoch = 0;
    this.restorePointsDir = path.join(config.dataDir, "restore-points");
  }

  async initialize() {
    await fs.mkdir(this.uploadsDir, { recursive: true });
    for (const slot of Object.keys(UPLOAD_SLOTS)) await fs.mkdir(path.join(this.uploadsDir, slot), { recursive: true });
    await fs.mkdir(path.join(this.uploadsDir, "articles"), { recursive: true });
    this.db = new DatabaseSync(this.databasePath);
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec("PRAGMA foreign_keys = ON");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS assets (
        slot TEXT PRIMARY KEY,
        filename TEXT NOT NULL,
        original_name TEXT NOT NULL,
        mime TEXT NOT NULL,
        size INTEGER NOT NULL,
        sha256 TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS articles (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        slug TEXT NOT NULL UNIQUE,
        title TEXT NOT NULL,
        published_at TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('draft', 'published')),
        pdf_filename TEXT NOT NULL,
        original_name TEXT NOT NULL,
        pdf_size INTEGER NOT NULL,
        pdf_sha256 TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_articles_status_published
      ON articles(status, published_at DESC);
    `);
    this.seedSettings();
    await this.seedAssets();
    await this.seedArticles();
    this.library = new ArticleLibrary({ db: this.db, uploadsDir: this.uploadsDir, config: this.config });
    await this.library.initialize();
    this.db.exec("PRAGMA optimize");
  }

  seedSettings() {
    const statement = this.db.prepare("INSERT OR IGNORE INTO settings(key, value) VALUES (?, ?)");
    for (const [key, value] of Object.entries(DEFAULT_SETTINGS)) statement.run(key, value);
  }

  async seedAssets() {
    const defaults = {
      heroImage: ["hero.png", "image/png"],
      aboutImage: ["about.png", "image/png"],
      journalImage: ["journal.png", "image/png"],
      aboutMarkdown: ["about-me.md", "text/markdown"],
    };
    const insert = this.db.prepare(`
      INSERT OR IGNORE INTO assets(slot, filename, original_name, mime, size, sha256, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    for (const [slot, [filename, mime]] of Object.entries(defaults)) {
      if (this.db.prepare("SELECT 1 FROM assets WHERE slot = ?").get(slot)) continue;
      const source = path.join(this.config.defaultsDir, filename);
      try {
        const data = await fs.readFile(source);
        await atomicWrite(path.join(this.uploadsDir, slot, filename), data);
        insert.run(slot, filename, filename, mime, data.length, sha256(data), new Date().toISOString());
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
    }
  }

  async seedArticles() {
    const count = this.db.prepare("SELECT COUNT(*) AS count FROM articles").get().count;
    if (count) return;
    const seeds = [
      ["The Shape of a Working Idea", "shape-of-a-working-idea", "2026-08-15T12:00:00.000Z", "study-one.pdf"],
      ["Notes on Reversible Systems", "notes-on-reversible-systems", "2026-08-05T12:00:00.000Z", "study-two.pdf"],
      ["A Small Atlas of Attention", "small-atlas-of-attention", "2026-07-24T12:00:00.000Z", "study-three.pdf"],
    ];
    const insert = this.db.prepare(`
      INSERT INTO articles(slug, title, published_at, status, pdf_filename, original_name, pdf_size, pdf_sha256, created_at, updated_at)
      VALUES (?, ?, ?, 'published', ?, ?, ?, ?, ?, ?)
    `);
    for (const [title, slug, publishedAt, filename] of seeds) {
      const source = path.join(this.config.defaultsDir, filename);
      try {
        const data = await fs.readFile(source);
        await atomicWrite(path.join(this.uploadsDir, "articles", filename), data);
        const now = new Date().toISOString();
        insert.run(slug, title, publishedAt, filename, filename, data.length, sha256(data), now, now);
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
    }
  }

  getContent() {
    const content = normalizeSettings(this.db.prepare("SELECT key, value FROM settings").all());
    const assets = {};
    for (const row of this.db.prepare("SELECT * FROM assets").all()) assets[row.slot] = publicAssetUrl(row.slot, row.filename);
    return { ...content, publicAssets: assets, updatedAt: this.latestUpdate() };
  }

  latestUpdate() {
    const asset = this.db.prepare("SELECT MAX(updated_at) AS value FROM assets").get().value;
    const article = this.db.prepare("SELECT MAX(updated_at) AS value FROM library_articles").get().value;
    return [asset, article].filter(Boolean).sort().at(-1) ?? null;
  }

  updateContent(input) {
    const values = validateSettings(input);
    const statement = this.db.prepare("INSERT INTO settings(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value");
    this.db.exec("BEGIN IMMEDIATE");
    try {
      for (const [key, value] of Object.entries(values)) statement.run(key, value);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    return this.getContent();
  }

  listArticles({ query = "", sort = "newest", includeDrafts = false } = {}) {
    return this.library.listArticles({ query, sort, includeDrafts });
  }

  getArticle(slug, includeDrafts = false) {
    return this.library.getArticle(slug, includeDrafts);
  }

  async saveAsset(slot, file) {
    const { extension, mime } = validateUpload(slot, file);
    const filename = `${Date.now()}-${crypto.randomBytes(6).toString("hex")}${extension}`;
    const destination = path.join(this.uploadsDir, slot, filename);
    const previous = this.db.prepare("SELECT filename FROM assets WHERE slot = ?").get(slot)?.filename;
    await atomicWrite(destination, file.buffer);
    this.db.prepare(`
      INSERT INTO assets(slot, filename, original_name, mime, size, sha256, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(slot) DO UPDATE SET filename = excluded.filename, original_name = excluded.original_name,
        mime = excluded.mime, size = excluded.size, sha256 = excluded.sha256, updated_at = excluded.updated_at
    `).run(slot, filename, path.basename(file.originalname || filename), mime, file.buffer.length, sha256(file.buffer), new Date().toISOString());
    if (previous && previous !== filename) await fs.rm(path.join(this.uploadsDir, slot, previous), { force: true });
    return this.getContent();
  }

  async readAsset(slot) {
    if (!UPLOAD_SLOTS[slot]) throw new Error("Unknown upload slot");
    const row = this.db.prepare("SELECT * FROM assets WHERE slot = ?").get(slot);
    if (!row) return null;
    if (!safeFilename(row.filename)) throw new Error("Invalid stored asset filename");
    const data = await fs.readFile(path.join(this.uploadsDir, slot, row.filename));
    if (data.length !== row.size || sha256(data) !== row.sha256) throw new Error(`Asset checksum mismatch: ${slot}`);
    return { ...row, data };
  }

  async removeAsset(slot) {
    if (!UPLOAD_SLOTS[slot]) throw new Error("Unknown upload slot");
    const previous = this.db.prepare("SELECT filename FROM assets WHERE slot = ?").get(slot)?.filename;
    this.db.prepare("DELETE FROM assets WHERE slot = ?").run(slot);
    if (previous) await fs.rm(path.join(this.uploadsDir, slot, previous), { force: true });
    return this.getContent();
  }

  exportSnapshot() {
    return {
      schema: "exocortex.laboratory.backup.v3",
      exportedAt: new Date().toISOString(),
      settings: this.db.prepare("SELECT key, value FROM settings ORDER BY key").all(),
      assets: this.db.prepare("SELECT * FROM assets ORDER BY slot").all(),
      library: this.library.exportSnapshot(),
      notifications: this.exportNotificationSnapshot(),
    };
  }

  tableExists(name) {
    return Boolean(this.db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name));
  }

  exportNotificationSnapshot() {
    return {
      jobs: this.tableExists("search_notification_jobs")
        ? this.db.prepare("SELECT * FROM search_notification_jobs ORDER BY provider, revision_id").all() : [],
      state: this.tableExists("search_notification_state")
        ? this.db.prepare("SELECT * FROM search_notification_state ORDER BY provider").all() : [],
      urlJobs: this.tableExists("search_notification_url_jobs")
        ? this.db.prepare("SELECT * FROM search_notification_url_jobs ORDER BY provider, slug, event_at").all() : [],
    };
  }

  async backupFiles(snapshot) {
    const files = {};
    for (const asset of snapshot.assets) {
      files[`assets/${asset.slot}/${asset.filename}`] = await fs.readFile(path.join(this.uploadsDir, asset.slot, asset.filename));
    }
    Object.assign(files, await this.library.backupFiles(snapshot.library));
    return files;
  }

  async saveRestorePoint(archive) {
    if (!archive?.length) throw new Error("Pre-restore backup is empty");
    await fs.mkdir(this.restorePointsDir, { recursive: true, mode: 0o700 });
    const stamp = new Date().toISOString().replace(/[-:TZ.]/g, "").slice(0, 14);
    const filename = path.join(this.restorePointsDir, `before-restore-${stamp}-${crypto.randomBytes(3).toString("hex")}.zip`);
    await atomicWrite(filename, archive);
    const entries = (await fs.readdir(this.restorePointsDir, { withFileTypes: true }))
      .filter((entry) => entry.isFile() && /^before-restore-\d{14}-[a-f0-9]{6}\.zip$/.test(entry.name))
      .map((entry) => entry.name).sort().reverse();
    for (const stale of entries.slice(3)) await fs.rm(path.join(this.restorePointsDir, stale), { force: true });
    return filename;
  }

  restoreNotificationDatabase(snapshot) {
    if (!this.tableExists("search_notification_jobs")) return;
    this.db.exec("DELETE FROM search_notification_jobs; DELETE FROM search_notification_state; DELETE FROM search_notification_url_jobs;");
    const notifications = snapshot.notifications || {};
    const jobInsert = this.db.prepare(`
      INSERT INTO search_notification_jobs(provider, revision_id, status, attempts, last_error, next_attempt_at,
        accepted_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const row of notifications.jobs || []) jobInsert.run(
      row.provider, row.revision_id, row.status === "running" ? "pending" : row.status, row.attempts,
      row.last_error, row.next_attempt_at, row.accepted_at, row.created_at, row.updated_at,
    );
    const stateInsert = this.db.prepare("INSERT INTO search_notification_state(provider, initialized_at) VALUES (?, ?)");
    for (const row of notifications.state || []) stateInsert.run(row.provider, row.initialized_at);
    const urlInsert = this.db.prepare(`
      INSERT INTO search_notification_url_jobs(provider, slug, event_at, status, attempts, last_error,
        next_attempt_at, accepted_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const row of notifications.urlJobs || []) urlInsert.run(
      row.provider, row.slug, row.event_at, row.status === "running" ? "pending" : row.status,
      row.attempts, row.last_error, row.next_attempt_at, row.accepted_at, row.created_at, row.updated_at,
    );
  }

  async restoreSnapshot(snapshot, files) {
    if (this.restoreInProgress) throw new Error("A restore is already in progress");
    if (!["exocortex.laboratory.backup.v1", "exocortex.laboratory.backup.v2", "exocortex.laboratory.backup.v3"].includes(snapshot?.schema)) throw new Error("Unsupported Laboratory backup schema");
    if (!Array.isArray(snapshot.settings) || !Array.isArray(snapshot.assets)) {
      throw new Error("Invalid Laboratory backup structure");
    }
    const operation = crypto.randomBytes(8).toString("hex");
    const stagingRoot = path.join(this.config.dataDir, `.restore-stage-${operation}`);
    const stagedUploads = path.join(stagingRoot, "uploads");
    const rollbackUploads = path.join(this.config.dataDir, `.restore-rollback-${operation}`);
    const expectedFiles = new Set();
    this.restoreInProgress = true;
    this.restoreEpoch += 1;
    this.library.restoreInProgress = true;
    this.library.restoreEpoch = this.restoreEpoch;
    try {
      await fs.mkdir(stagedUploads, { recursive: true, mode: 0o700 });
      for (const slot of Object.keys(UPLOAD_SLOTS)) await fs.mkdir(path.join(stagedUploads, slot), { recursive: true });
      await fs.mkdir(path.join(stagedUploads, "articles"), { recursive: true });
      await fs.mkdir(path.join(stagedUploads, "library"), { recursive: true });
      for (const asset of snapshot.assets) {
        if (!UPLOAD_SLOTS[asset.slot] || !safeFilename(asset.filename)) throw new Error("Invalid asset entry in backup");
        const member = `assets/${asset.slot}/${asset.filename}`;
        const data = files[member];
        if (!data || data.length !== asset.size || sha256(data) !== asset.sha256) throw new Error(`Asset checksum mismatch: ${asset.slot}`);
        expectedFiles.add(member);
        await atomicWrite(path.join(stagedUploads, asset.slot, asset.filename), data);
      }
      if (snapshot.schema === "exocortex.laboratory.backup.v1") {
        if (!Array.isArray(snapshot.articles)) throw new Error("Invalid legacy article backup");
        for (const article of snapshot.articles) {
          if (!safeFilename(article.pdf_filename)) throw new Error("Invalid article file in backup");
          const member = `articles/${article.pdf_filename}`;
          const data = files[member];
          if (!data || data.length !== article.pdf_size || sha256(data) !== article.pdf_sha256) throw new Error(`Article checksum mismatch: ${article.slug}`);
          expectedFiles.add(member);
          await atomicWrite(path.join(stagedUploads, "articles", article.pdf_filename), data);
        }
      } else {
        for (const member of await this.library.stageRestoreFiles(snapshot.library, files, path.join(stagedUploads, "library"))) expectedFiles.add(member);
      }
      const suppliedFiles = Object.keys(files);
      if (suppliedFiles.some((name) => !expectedFiles.has(name))) throw new Error("Backup contains files that are not owned by its snapshot");

      this.db.exec("BEGIN IMMEDIATE");
      let oldTreeMoved = false;
      let newTreeMoved = false;
      try {
        await fs.rename(this.uploadsDir, rollbackUploads);
        oldTreeMoved = true;
        await fs.rename(stagedUploads, this.uploadsDir);
        newTreeMoved = true;
        this.db.exec("DELETE FROM settings; DELETE FROM assets;");
      const settingInsert = this.db.prepare("INSERT INTO settings(key, value) VALUES (?, ?)");
      for (const item of snapshot.settings) settingInsert.run(item.key, item.value);
      const assetInsert = this.db.prepare("INSERT INTO assets(slot, filename, original_name, mime, size, sha256, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)");
      for (const item of snapshot.assets) assetInsert.run(item.slot, item.filename, item.original_name, item.mime, item.size, item.sha256, item.updated_at);
      if (snapshot.schema === "exocortex.laboratory.backup.v1") {
        this.db.exec("DELETE FROM article_slug_aliases; DELETE FROM article_files; DELETE FROM article_revisions; DELETE FROM library_articles; DELETE FROM articles;");
        const articleInsert = this.db.prepare(`
          INSERT INTO articles(id, slug, title, published_at, status, pdf_filename, original_name, pdf_size, pdf_sha256, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `);
        for (const item of snapshot.articles) articleInsert.run(item.id, item.slug, item.title, item.published_at, item.status, item.pdf_filename, item.original_name, item.pdf_size, item.pdf_sha256, item.created_at, item.updated_at);
        this.db.prepare("DELETE FROM sqlite_sequence WHERE name = 'articles'").run();
        const maximumArticleId = this.db.prepare("SELECT COALESCE(MAX(id), 0) AS value FROM articles").get().value;
        if (maximumArticleId) this.db.prepare("INSERT INTO sqlite_sequence(name, seq) VALUES ('articles', ?)").run(maximumArticleId);
      } else {
        this.library.restoreDatabase(snapshot.library);
      }
        this.restoreNotificationDatabase(snapshot);
        const foreignKeyFailures = this.db.prepare("PRAGMA foreign_key_check").all();
        if (foreignKeyFailures.length) throw new Error("Restored database violates foreign-key invariants");
        this.db.exec("COMMIT");
      } catch (error) {
        try { this.db.exec("ROLLBACK"); } catch {}
        if (newTreeMoved) {
          await fs.rm(this.uploadsDir, { recursive: true, force: true });
        }
        if (oldTreeMoved) {
          await fs.rename(rollbackUploads, this.uploadsDir);
        }
        throw error;
      }
      await fs.rm(rollbackUploads, { recursive: true, force: true });
      if (snapshot.schema === "exocortex.laboratory.backup.v1") await this.library.migrateLegacyArticles();
      this.db.exec("PRAGMA optimize");
      return { settings: snapshot.settings.length, assets: snapshot.assets.length, articles: snapshot.library?.articles?.length ?? snapshot.articles?.length ?? 0 };
    } finally {
      this.restoreInProgress = false;
      this.library.restoreInProgress = false;
      await fs.rm(stagingRoot, { recursive: true, force: true });
    }
  }

  close() {
    this.db?.close();
  }
}
