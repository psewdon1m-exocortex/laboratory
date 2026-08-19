import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import {
  ARTICLE_ID_PATTERN,
  buildArticleArchive,
  detectArticleMime,
  generateArticleId,
  parseArticleArchive,
  parseOpenNodeProject,
} from "./article-archive.js";
import { renderArticleMarkdown } from "./article-markdown.js";

function sha256(buffer) {
  return crypto.createHash("sha256").update(buffer).digest("hex");
}

function slugify(value) {
  const base = String(value ?? "").normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLowerCase()
    .replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 96);
  return base || "article";
}

function cleanTitle(value) {
  const title = String(value ?? "").normalize("NFC").trim();
  if (!title || title.length > 160 || /[\u0000-\u001f\u007f/\\]/.test(title)) throw new Error("Article title must contain 1-160 safe characters");
  return title;
}

function cleanSlug(value) {
  const slug = slugify(value);
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug)) throw new Error("Invalid article slug");
  return slug;
}

function cleanAssetName(value) {
  const name = path.basename(String(value ?? "")).normalize("NFC").trim();
  if (!name || name.startsWith(".") || name.length > 120 || /[\u0000-\u001f\u007f/\\]/.test(name)) throw new Error("Invalid article filename");
  return name;
}

function safeStoragePath(value) {
  const normalized = String(value ?? "").replaceAll("\\", "/");
  return normalized.length > 0 && normalized.length <= 320 && !normalized.startsWith("/")
    && !normalized.split("/").some((part) => !part || part === "." || part === "..");
}

async function atomicWrite(filename, buffer) {
  await fs.mkdir(path.dirname(filename), { recursive: true });
  const temporary = path.join(path.dirname(filename), `.${path.basename(filename)}.${process.pid}.${crypto.randomBytes(3).toString("hex")}.tmp`);
  await fs.writeFile(temporary, buffer, { mode: 0o600 });
  await fs.rename(temporary, filename);
}

function revisionLabel(number) {
  return `r${String(number).padStart(4, "0")}`;
}

function toStorageStatus(value) {
  if (value === "published") return "published";
  if (["unpublished", "draft", "archived"].includes(value)) return "draft";
  throw new Error("Article status must be published or unpublished");
}

function toPublicStatus(value) {
  return value === "published" ? "published" : "unpublished";
}

export class ArticleLibrary {
  constructor({ db, uploadsDir, config, recordContentEvent = () => null }) {
    this.db = db;
    this.config = config;
    this.rootDir = path.join(uploadsDir, "library");
    this.recordContentEvent = recordContentEvent;
  }

  async initialize() {
    await fs.mkdir(this.rootDir, { recursive: true });
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS library_articles (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        internal_id TEXT NOT NULL UNIQUE,
        slug TEXT NOT NULL UNIQUE,
        title TEXT NOT NULL,
        source_status TEXT NOT NULL CHECK(source_status IN ('draft', 'published', 'archived')),
        published_at TEXT,
        revised_at TEXT,
        current_revision_id INTEGER,
        published_revision_id INTEGER,
        source_path TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS article_revisions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        article_id INTEGER NOT NULL REFERENCES library_articles(id) ON DELETE CASCADE,
        revision_number INTEGER NOT NULL,
        title TEXT NOT NULL,
        format TEXT NOT NULL CHECK(format IN ('pdf', 'markdown')),
        main_path TEXT NOT NULL,
        markdown_source TEXT,
        metadata_json TEXT NOT NULL DEFAULT '{}',
        source_sha256 TEXT NOT NULL,
        archive_sha256 TEXT NOT NULL,
        source_kind TEXT NOT NULL,
        source_commit TEXT,
        state TEXT NOT NULL CHECK(state IN ('draft', 'published', 'archived')),
        created_at TEXT NOT NULL,
        UNIQUE(article_id, revision_number)
      );
      CREATE TABLE IF NOT EXISTS article_files (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        revision_id INTEGER NOT NULL REFERENCES article_revisions(id) ON DELETE CASCADE,
        path TEXT NOT NULL,
        storage_path TEXT NOT NULL UNIQUE,
        mime TEXT NOT NULL,
        kind TEXT NOT NULL CHECK(kind IN ('main', 'media', 'attachment')),
        size INTEGER NOT NULL,
        sha256 TEXT NOT NULL,
        UNIQUE(revision_id, path)
      );
      CREATE TABLE IF NOT EXISTS article_slug_aliases (
        slug TEXT PRIMARY KEY,
        article_id INTEGER NOT NULL REFERENCES library_articles(id) ON DELETE CASCADE
      );
      CREATE TABLE IF NOT EXISTS article_derivatives (
        revision_id INTEGER PRIMARY KEY REFERENCES article_revisions(id) ON DELETE CASCADE,
        generation_key TEXT,
        source_sha256 TEXT NOT NULL,
        provider TEXT NOT NULL,
        model TEXT NOT NULL,
        prompt_version TEXT NOT NULL,
        description TEXT NOT NULL,
        abstract_markdown TEXT NOT NULL,
        transcript_markdown TEXT,
        evidence_json TEXT NOT NULL,
        warnings_json TEXT NOT NULL,
        manifest_json TEXT NOT NULL,
        abstract_path TEXT NOT NULL,
        transcript_path TEXT,
        evidence_path TEXT NOT NULL,
        manifest_path TEXT NOT NULL,
        generated_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS article_derivative_generations (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        revision_id INTEGER NOT NULL REFERENCES article_revisions(id) ON DELETE CASCADE,
        generation_key TEXT NOT NULL,
        source_sha256 TEXT NOT NULL,
        provider TEXT NOT NULL,
        model TEXT NOT NULL,
        prompt_version TEXT NOT NULL,
        manifest_json TEXT NOT NULL,
        artifact_root TEXT NOT NULL,
        generated_at TEXT NOT NULL,
        UNIQUE(revision_id, generation_key)
      );
      CREATE TABLE IF NOT EXISTS article_generation_jobs (
        revision_id INTEGER PRIMARY KEY REFERENCES article_revisions(id) ON DELETE CASCADE,
        status TEXT NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 0,
        last_error TEXT,
        usage_json TEXT,
        next_attempt_at TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS library_sync_state (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS gone_urls (
        slug TEXT PRIMARY KEY,
        removed_at TEXT NOT NULL,
        reason TEXT NOT NULL,
        replacement_slug TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_library_articles_publication
      ON library_articles(source_status, published_at DESC);
      CREATE INDEX IF NOT EXISTS idx_article_revisions_article
      ON article_revisions(article_id, revision_number DESC);
      CREATE INDEX IF NOT EXISTS idx_article_files_revision
      ON article_files(revision_id);
    `);
    if (!this.db.prepare("PRAGMA table_info(article_revisions)").all().some((column) => column.name === "metadata_json")) {
      this.db.exec("ALTER TABLE article_revisions ADD COLUMN metadata_json TEXT NOT NULL DEFAULT '{}'");
    }
    if (!this.db.prepare("PRAGMA table_info(article_derivatives)").all().some((column) => column.name === "generation_key")) {
      this.db.exec("ALTER TABLE article_derivatives ADD COLUMN generation_key TEXT");
    }
    if (!this.db.prepare("PRAGMA table_info(article_generation_jobs)").all().some((column) => column.name === "usage_json")) {
      this.db.exec("ALTER TABLE article_generation_jobs ADD COLUMN usage_json TEXT");
    }
    this.db.prepare("UPDATE article_derivatives SET generation_key = 'legacy-' || revision_id WHERE generation_key IS NULL OR generation_key = ''").run();
    await this.migrateLegacyArticles();
    this.db.prepare("UPDATE library_articles SET source_status = 'draft' WHERE source_status = 'archived'").run();
    this.db.exec("PRAGMA optimize");
  }

  nextInternalId() {
    for (let attempt = 0; attempt < 16; attempt += 1) {
      const candidate = generateArticleId();
      if (!this.db.prepare("SELECT 1 FROM library_articles WHERE internal_id = ?").get(candidate)) return candidate;
    }
    throw new Error("Could not allocate a unique Laboratory article ID");
  }

  uniqueSlug(value, articleId = null) {
    const base = cleanSlug(value);
    let candidate = base;
    for (let index = 2; index < 10_000; index += 1) {
      const match = this.db.prepare("SELECT article_id FROM article_slug_aliases WHERE slug = ?").get(candidate);
      if (!match || match.article_id === articleId) return candidate;
      candidate = `${base}-${index}`;
    }
    throw new Error("Could not allocate a unique article URL");
  }

  async migrateLegacyArticles() {
    const existing = this.db.prepare("SELECT COUNT(*) AS count FROM library_articles").get().count;
    if (existing) return;
    const legacy = this.db.prepare("SELECT * FROM articles ORDER BY id").all();
    for (const article of legacy) {
      const filename = path.join(path.dirname(this.rootDir), "articles", article.pdf_filename);
      let bytes;
      try { bytes = await fs.readFile(filename); } catch (error) { if (error.code === "ENOENT") continue; else throw error; }
      const parsed = parseArticleArchive(buildArticleArchive({
        internalId: this.nextInternalId(),
        files: [{ path: "article.pdf", bytes }],
      }), { archiveName: `${article.title}.zip`, status: article.status === "published" ? "published" : "unpublished" });
      await this.importArchive(parsed, {
        sourceKind: "seed",
        now: article.created_at,
        publishedAt: article.published_at,
        slug: article.slug,
      });
    }
  }

  articleRowByReference(reference) {
    if (typeof reference === "number" || /^\d+$/.test(String(reference))) {
      return this.db.prepare("SELECT * FROM library_articles WHERE id = ?").get(Number(reference));
    }
    if (ARTICLE_ID_PATTERN.test(String(reference))) return this.db.prepare("SELECT * FROM library_articles WHERE internal_id = ?").get(reference);
    return this.db.prepare(`
      SELECT a.* FROM library_articles a
      JOIN article_slug_aliases aliases ON aliases.article_id = a.id
      WHERE aliases.slug = ?
    `).get(reference);
  }

  revisionRow(revisionId) {
    return revisionId ? this.db.prepare("SELECT * FROM article_revisions WHERE id = ?").get(revisionId) : null;
  }

  revisionFiles(revisionId) {
    return this.db.prepare("SELECT * FROM article_files WHERE revision_id = ? ORDER BY path").all(revisionId).map((row) => ({
      path: row.path,
      mime: row.mime,
      kind: row.kind,
      size: row.size,
      sha256: row.sha256,
      storagePath: row.storage_path,
    }));
  }

  async revisionFilesWithBytes(revisionId) {
    const result = [];
    for (const file of this.revisionFiles(revisionId)) {
      result.push({ ...file, bytes: await fs.readFile(path.join(this.rootDir, file.storagePath)) });
    }
    return result;
  }

  validateParsed(parsed, context) {
    if (parsed.format === "markdown") renderArticleMarkdown(parsed.markdownSource, parsed.files, context);
    for (const file of parsed.files.filter((candidate) => candidate.mime === "application/vnd.open-node.project")) {
      parseOpenNodeProject(file.bytes, file.path);
    }
  }

  async importArchive(parsedOrBuffer, options = {}) {
    const parsed = Buffer.isBuffer(parsedOrBuffer) || parsedOrBuffer instanceof Uint8Array
      ? parseArticleArchive(parsedOrBuffer, options)
      : parsedOrBuffer;
    const storageStatus = toStorageStatus(parsed.status);
    const now = options.now || new Date().toISOString();
    let article = parsed.internalId ? this.articleRowByReference(parsed.internalId) : null;
    if (!article && options.sourcePath) article = this.db.prepare("SELECT * FROM library_articles WHERE source_path = ?").get(options.sourcePath);
    if (article && parsed.internalId && parsed.internalId !== article.internal_id) throw new Error("The archive ID conflicts with the article already assigned to this source path");
    const internalId = article?.internal_id || parsed.internalId || this.nextInternalId();
    const requestedSlug = options.slug || article?.slug || parsed.title;
    const slug = this.uniqueSlug(requestedSlug, article?.id ?? null);
    const currentRevision = article ? this.revisionRow(article.current_revision_id) : null;
    const previousSlug = article?.slug || null;
    const wasPublished = article?.source_status === "published";
    const previousPublishedRevision = article?.published_revision_id ? this.revisionRow(article.published_revision_id) : null;
    if (currentRevision?.source_sha256 === parsed.sourceSha256 && currentRevision.state === storageStatus
        && currentRevision.title === parsed.title && slug === article.slug) {
      return { article: this.readArticle(article, currentRevision, true), changed: false, assignedId: !parsed.internalId, archive: await this.exportArchive(article.internal_id) };
    }
    const revisionNumber = article
      ? this.db.prepare("SELECT COALESCE(MAX(revision_number), 0) + 1 AS value FROM article_revisions WHERE article_id = ?").get(article.id).value
      : 1;
    this.validateParsed(parsed, { internalId, revisionNumber });
    const storedFiles = [];
    for (const file of parsed.files) {
      const extension = path.extname(file.path).toLowerCase().replace(/[^.a-z0-9]/g, "").slice(0, 12);
      const pathDigest = sha256(Buffer.from(file.path, "utf8")).slice(0, 12);
      const storagePath = path.posix.join(internalId, revisionLabel(revisionNumber), `${file.sha256}-${pathDigest}${extension}`);
      await atomicWrite(path.join(this.rootDir, storagePath), file.bytes);
      storedFiles.push({ ...file, storagePath });
    }
    this.db.exec("BEGIN IMMEDIATE");
    try {
      if (!article) {
        const inserted = this.db.prepare(`
          INSERT INTO library_articles(internal_id, slug, title, source_status, published_at, revised_at, source_path, created_at, updated_at)
          VALUES (?, ?, ?, ?, NULL, NULL, ?, ?, ?)
        `).run(internalId, slug, parsed.title, storageStatus, options.sourcePath || null, now, now);
        article = this.db.prepare("SELECT * FROM library_articles WHERE id = ?").get(Number(inserted.lastInsertRowid));
        this.db.prepare("INSERT INTO article_slug_aliases(slug, article_id) VALUES (?, ?)").run(slug, article.id);
      } else if (slug !== article.slug) {
        this.db.prepare("INSERT OR IGNORE INTO article_slug_aliases(slug, article_id) VALUES (?, ?)").run(slug, article.id);
      }
      const revisionInsert = this.db.prepare(`
        INSERT INTO article_revisions(article_id, revision_number, title, format, main_path, markdown_source, metadata_json, source_sha256, archive_sha256, source_kind, source_commit, state, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(article.id, revisionNumber, parsed.title, parsed.format, parsed.mainPath, parsed.markdownSource, JSON.stringify(parsed.metadata || {}),
        parsed.sourceSha256, parsed.archiveSha256, options.sourceKind || "admin", options.sourceCommit || null, storageStatus, now);
      const revisionId = Number(revisionInsert.lastInsertRowid);
      const fileInsert = this.db.prepare(`
        INSERT INTO article_files(revision_id, path, storage_path, mime, kind, size, sha256)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `);
      for (const file of storedFiles) fileInsert.run(revisionId, file.path, file.storagePath, file.mime, file.kind, file.size, file.sha256);
      let publishedAt = article.published_at;
      let revisedAt = article.revised_at;
      let publishedRevisionId = article.published_revision_id;
      if (storageStatus === "published") {
        if (!publishedAt) publishedAt = options.publishedAt || now;
        else if (publishedRevisionId && (
          previousPublishedRevision?.source_sha256 !== parsed.sourceSha256
          || previousPublishedRevision?.title !== parsed.title
          || previousSlug !== slug
        )) revisedAt = now;
        publishedRevisionId = revisionId;
      }
      this.db.prepare(`
        UPDATE library_articles
        SET slug = ?, title = ?, source_status = ?, published_at = ?, revised_at = ?, current_revision_id = ?,
            published_revision_id = ?, source_path = COALESCE(?, source_path), updated_at = ?
        WHERE id = ?
      `).run(slug, parsed.title, storageStatus, publishedAt, revisedAt, revisionId, publishedRevisionId, options.sourcePath || null, now, article.id);
      if (wasPublished && previousSlug && previousSlug !== slug) {
        this.db.prepare(`
          INSERT INTO gone_urls(slug, removed_at, reason, replacement_slug) VALUES (?, ?, 'moved', ?)
          ON CONFLICT(slug) DO UPDATE SET removed_at = excluded.removed_at, reason = excluded.reason, replacement_slug = excluded.replacement_slug
        `).run(previousSlug, now, slug);
      }
      if (wasPublished && storageStatus !== "published" && previousSlug) {
        this.db.prepare(`
          INSERT INTO gone_urls(slug, removed_at, reason, replacement_slug) VALUES (?, ?, 'unpublished', NULL)
          ON CONFLICT(slug) DO UPDATE SET removed_at = excluded.removed_at, reason = excluded.reason, replacement_slug = NULL
        `).run(previousSlug, now);
      }
      if (storageStatus === "published") this.db.prepare("DELETE FROM gone_urls WHERE slug = ?").run(slug);
      if (wasPublished || storageStatus === "published") {
        const eventType = wasPublished && storageStatus !== "published"
          ? "ContentUnpublished"
          : !wasPublished && storageStatus === "published"
            ? "ContentPublished"
            : previousSlug !== slug
              ? "CanonicalChanged"
              : "ContentUpdated";
        const eventTimestamp = this.recordContentEvent({
          eventType,
          scope: "journal",
          entityId: internalId,
          slug,
          previousSlug: previousSlug !== slug ? previousSlug : null,
          occurredAt: now,
        });
        if (storageStatus === "published" && revisedAt === now && eventTimestamp !== now) {
          revisedAt = eventTimestamp;
          this.db.prepare("UPDATE library_articles SET revised_at = ? WHERE id = ?").run(revisedAt, article.id);
        }
      }
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    const saved = this.articleRowByReference(internalId);
    return { article: this.readArticle(saved, this.revisionRow(saved.current_revision_id), true), changed: true, assignedId: !parsed.internalId, archive: await this.exportArchive(internalId) };
  }

  readArticle(article, revision, includeBody = false) {
    if (!article || !revision) return null;
    const files = this.revisionFiles(revision.id);
    const main = files.find((file) => file.path === revision.main_path);
    const derivative = this.db.prepare("SELECT * FROM article_derivatives WHERE revision_id = ? AND source_sha256 = ?").get(revision.id, revision.source_sha256);
    const generationJob = this.db.prepare("SELECT status, attempts, last_error AS lastError, usage_json AS usageJson, updated_at AS updatedAt FROM article_generation_jobs WHERE revision_id = ?").get(revision.id);
    if (generationJob) {
      generationJob.usage = generationJob.usageJson ? JSON.parse(generationJob.usageJson) : null;
      delete generationJob.usageJson;
    }
    const value = {
      id: article.internal_id,
      databaseId: article.id,
      internalId: article.internal_id,
      slug: article.slug,
      title: revision.title,
      status: toPublicStatus(article.source_status),
      revision: revision.revision_number,
      format: revision.format,
      publishedAt: article.published_at,
      revisedAt: article.revised_at,
      createdAt: article.created_at,
      updatedAt: article.updated_at,
      sourcePath: article.source_path,
      pdfSize: revision.format === "pdf" ? main?.size ?? 0 : null,
      pdfUrl: revision.format === "pdf" ? this.assetUrl(article.internal_id, revision.revision_number, revision.main_path) : null,
      metadata: JSON.parse(revision.metadata_json || "{}"),
      generatedDescription: derivative?.description || null,
      abstractMarkdown: derivative?.abstract_markdown || null,
      transcriptMarkdown: derivative?.transcript_markdown || null,
      generatedEvidence: derivative ? JSON.parse(derivative.evidence_json) : [],
      derivedContent: derivative ? {
        generationKey: derivative.generation_key,
        sourceSha256: derivative.source_sha256,
        provider: derivative.provider,
        model: derivative.model,
        promptVersion: derivative.prompt_version,
        generatedAt: derivative.generated_at,
        warnings: JSON.parse(derivative.warnings_json),
      } : null,
      generationJob: generationJob || null,
      abstractUrl: derivative ? this.derivedUrl(article.internal_id, revision.revision_number, derivative.generation_key, "abstract.md") : null,
      transcriptUrl: derivative?.transcript_markdown ? this.derivedUrl(article.internal_id, revision.revision_number, derivative.generation_key, "transcript.md") : null,
    };
    if (includeBody) {
      value.files = files.map(({ storagePath, ...file }) => file);
      if (revision.format === "markdown") {
        const rendered = renderArticleMarkdown(revision.markdown_source, files, {
          internalId: article.internal_id,
          revisionNumber: revision.revision_number,
        });
        value.bodyHtml = rendered.html;
        value.warnings = rendered.warnings;
        value.markdownSource = revision.markdown_source;
      }
      if (derivative) {
        value.abstractHtml = renderArticleMarkdown(derivative.abstract_markdown, [], {
          internalId: article.internal_id,
          revisionNumber: revision.revision_number,
        }).html;
        value.transcriptHtml = derivative.transcript_markdown ? renderArticleMarkdown(derivative.transcript_markdown, [], {
          internalId: article.internal_id,
          revisionNumber: revision.revision_number,
        }).html : null;
      }
    }
    return value;
  }

  assetUrl(internalId, revisionNumber, filePath) {
    return `/api/article-assets/${encodeURIComponent(internalId)}/${revisionNumber}/${filePath.split("/").map(encodeURIComponent).join("/")}`;
  }

  derivedUrl(internalId, revisionNumber, generationKey, filename) {
    return `/api/article-derived/${encodeURIComponent(internalId)}/${revisionNumber}/${encodeURIComponent(generationKey)}/${encodeURIComponent(filename)}`;
  }

  listArticles({ query = "", sort = "newest", includeDrafts = false } = {}) {
    const direction = sort === "oldest" ? "ASC" : "DESC";
    const escaped = String(query).trim().replace(/[\\%_]/g, "\\$&");
    const visibility = includeDrafts ? "a.current_revision_id IS NOT NULL" : "a.published_revision_id IS NOT NULL AND a.source_status = 'published'";
    const revisionColumn = includeDrafts ? "a.current_revision_id" : "a.published_revision_id";
    const rows = this.db.prepare(`
      SELECT a.*, r.id AS selected_revision_id
      FROM library_articles a JOIN article_revisions r ON r.id = ${revisionColumn}
      WHERE ${visibility} AND r.title LIKE ? ESCAPE '\\' COLLATE NOCASE
      ORDER BY COALESCE(a.published_at, a.created_at) ${direction}, a.id ${direction}
    `).all(`%${escaped}%`);
    return rows.map((row) => this.readArticle(row, this.revisionRow(row.selected_revision_id), false));
  }

  getArticle(reference, includeDrafts = false) {
    const article = this.articleRowByReference(reference);
    if (!article) return null;
    const revisionId = includeDrafts ? article.current_revision_id : article.published_revision_id;
    if (!revisionId || (!includeDrafts && article.source_status !== "published")) return null;
    return this.readArticle(article, this.revisionRow(revisionId), true);
  }

  getAdminArticle(reference) {
    const article = this.articleRowByReference(reference);
    if (!article) return null;
    const value = this.readArticle(article, this.revisionRow(article.current_revision_id), true);
    value.revisions = this.db.prepare(`
      SELECT revision_number AS revision, state, source_kind AS sourceKind, source_commit AS sourceCommit,
             created_at AS createdAt, source_sha256 AS sourceSha256
      FROM article_revisions WHERE article_id = ? ORDER BY revision_number DESC
    `).all(article.id).map((revision) => ({ ...revision, state: toPublicStatus(revision.state) }));
    return value;
  }

  async getFile(internalId, revisionNumber, filePath, { workflow = false } = {}) {
    const article = this.articleRowByReference(internalId);
    if (!article || article.source_status !== "published") return null;
    const revision = this.db.prepare("SELECT * FROM article_revisions WHERE article_id = ? AND revision_number = ?").get(article.id, Number(revisionNumber));
    if (!revision || revision.id !== article.published_revision_id) return null;
    const file = this.db.prepare("SELECT * FROM article_files WHERE revision_id = ? AND path = ?").get(revision.id, String(filePath).replaceAll("\\", "/"));
    if (!file) return null;
    const bytes = await fs.readFile(path.join(this.rootDir, file.storage_path));
    const publicArticle = { internalId: article.internal_id, slug: article.slug, title: article.title };
    if (workflow) return { project: parseOpenNodeProject(bytes, file.path), file, article: publicArticle };
    return { bytes, file, article: publicArticle };
  }

  async getDerivedFile(internalId, revisionNumber, generationKey, filename) {
    if (!new Set(["abstract.md", "transcript.md", "evidence.json", "generation-manifest.json"]).has(filename)) return null;
    if (generationKey) {
      const generation = this.db.prepare(`
        SELECT g.artifact_root AS artifactRoot
        FROM library_articles a
        JOIN article_revisions r ON r.id = a.published_revision_id
        JOIN article_derivative_generations g ON g.revision_id = r.id
        WHERE a.internal_id = ? AND a.source_status = 'published' AND r.revision_number = ? AND g.generation_key = ?
      `).get(internalId, Number(revisionNumber), generationKey);
      if (!generation?.artifactRoot) return null;
      try {
        return {
          bytes: await fs.readFile(path.join(this.rootDir, generation.artifactRoot, filename)),
          mime: filename.endsWith(".json") ? "application/json; charset=utf-8" : "text/markdown; charset=utf-8",
        };
      } catch (error) {
        if (error.code === "ENOENT") return null;
        throw error;
      }
    }
    const column = {
      "abstract.md": "abstract_path",
      "transcript.md": "transcript_path",
      "evidence.json": "evidence_path",
      "generation-manifest.json": "manifest_path",
    }[filename];
    if (!column) return null;
    const row = this.db.prepare(`
      SELECT d.${column} AS storage_path
      FROM library_articles a
      JOIN article_revisions r ON r.id = a.published_revision_id
      JOIN article_derivatives d ON d.revision_id = r.id AND d.source_sha256 = r.source_sha256
      WHERE a.internal_id = ? AND a.source_status = 'published' AND r.revision_number = ?
    `).get(internalId, Number(revisionNumber));
    if (!row?.storage_path) return null;
    return {
      bytes: await fs.readFile(path.join(this.rootDir, row.storage_path)),
      mime: filename.endsWith(".json") ? "application/json; charset=utf-8" : "text/markdown; charset=utf-8",
    };
  }

  async exportArchive(reference) {
    const article = this.articleRowByReference(reference);
    if (!article) throw new Error("Article not found");
    const files = await this.revisionFilesWithBytes(article.current_revision_id);
    const revision = this.revisionRow(article.current_revision_id);
    return buildArticleArchive({ internalId: article.internal_id, files, metadata: JSON.parse(revision.metadata_json || "{}") });
  }

  async revise(reference, changes = {}) {
    const article = this.articleRowByReference(reference);
    if (!article) throw new Error("Article not found");
    const revision = this.revisionRow(article.current_revision_id);
    let files = await this.revisionFilesWithBytes(revision.id);
    if (revision.format === "markdown" && changes.markdownSource != null) {
      const source = Buffer.from(String(changes.markdownSource), "utf8");
      files = files.map((file) => file.kind === "main" ? { ...file, bytes: source } : file);
    }
    const title = changes.title == null ? revision.title : cleanTitle(changes.title);
    const metadata = changes.metadata == null ? JSON.parse(revision.metadata_json || "{}") : changes.metadata;
    const archive = buildArticleArchive({ internalId: article.internal_id, files, metadata });
    return this.importArchive(archive, {
      archiveName: `${title}.zip`, status: changes.status || toPublicStatus(article.source_status), title,
      slug: changes.slug == null ? article.slug : cleanSlug(changes.slug), sourceKind: "admin", sourcePath: article.source_path,
    });
  }

  async replaceMain(reference, file, changes = {}) {
    const article = this.articleRowByReference(reference);
    if (!article) throw new Error("Article not found");
    if (!file?.buffer?.length) throw new Error("Article file is required");
    const isPdf = file.buffer.subarray(0, 5).toString("ascii") === "%PDF-";
    const isMarkdown = /\.md$/i.test(file.originalname || "");
    if (!isPdf && !isMarkdown) throw new Error("The main article file must be PDF or Markdown");
    const revision = this.revisionRow(article.current_revision_id);
    let files = (await this.revisionFilesWithBytes(revision.id)).filter((candidate) => candidate.kind !== "main");
    files.unshift({ path: isPdf ? "article.pdf" : "article.md", bytes: file.buffer });
    const title = cleanTitle(changes.title || revision.title);
    return this.importArchive(buildArticleArchive({ internalId: article.internal_id, files, metadata: JSON.parse(revision.metadata_json || "{}") }), {
      archiveName: `${title}.zip`, title, status: changes.status || toPublicStatus(article.source_status),
      slug: changes.slug || article.slug, sourceKind: "admin", sourcePath: article.source_path,
    });
  }

  async addFile(reference, folder, file) {
    if (!new Set(["media", "attachments"]).has(folder)) throw new Error("Article files must go into media or attachments");
    if (!file?.buffer?.length) throw new Error("File is required");
    const article = this.articleRowByReference(reference);
    if (!article) throw new Error("Article not found");
    const revision = this.revisionRow(article.current_revision_id);
    const target = `${folder}/${cleanAssetName(file.originalname)}`;
    const files = (await this.revisionFilesWithBytes(revision.id)).filter((candidate) => candidate.path !== target);
    files.push({ path: target, bytes: file.buffer });
    return this.importArchive(buildArticleArchive({ internalId: article.internal_id, files, metadata: JSON.parse(revision.metadata_json || "{}") }), {
      archiveName: `${revision.title}.zip`, status: toPublicStatus(article.source_status), title: revision.title,
      slug: article.slug, sourceKind: "admin", sourcePath: article.source_path,
    });
  }

  async removeFile(reference, filePath) {
    const article = this.articleRowByReference(reference);
    if (!article) throw new Error("Article not found");
    const revision = this.revisionRow(article.current_revision_id);
    const existing = await this.revisionFilesWithBytes(revision.id);
    const target = existing.find((file) => file.path === filePath);
    if (!target) throw new Error("Article file not found");
    if (target.kind === "main") throw new Error("The main article file cannot be removed");
    return this.importArchive(buildArticleArchive({ internalId: article.internal_id, files: existing.filter((file) => file.path !== filePath), metadata: JSON.parse(revision.metadata_json || "{}") }), {
      archiveName: `${revision.title}.zip`, status: toPublicStatus(article.source_status), title: revision.title,
      slug: article.slug, sourceKind: "admin", sourcePath: article.source_path,
    });
  }

  async deleteArticle(reference) {
    const article = this.articleRowByReference(reference);
    if (!article) throw new Error("Article not found");
    if (!ARTICLE_ID_PATTERN.test(article.internal_id)) throw new Error("Article storage identity is invalid");
    const storageRoot = path.resolve(this.rootDir);
    const articleRoot = path.resolve(this.rootDir, article.internal_id);
    if (path.dirname(articleRoot) !== storageRoot) throw new Error("Article storage path is outside the library root");
    const slugs = this.db.prepare("SELECT slug FROM article_slug_aliases WHERE article_id = ?").all(article.id).map((row) => row.slug);
    if (!slugs.includes(article.slug)) slugs.push(article.slug);
    const removedAt = new Date().toISOString();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const gone = this.db.prepare(`
        INSERT INTO gone_urls(slug, removed_at, reason, replacement_slug) VALUES (?, ?, 'deleted', NULL)
        ON CONFLICT(slug) DO UPDATE SET removed_at = excluded.removed_at, reason = excluded.reason, replacement_slug = NULL
      `);
      for (const slug of slugs) gone.run(slug, removedAt);
      if (article.source_status === "published") {
        this.recordContentEvent({
          eventType: "ContentDeleted",
          scope: "journal",
          entityId: article.internal_id,
          slug: article.slug,
          occurredAt: removedAt,
        });
      }
      this.db.prepare("DELETE FROM library_articles WHERE id = ?").run(article.id);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    await fs.rm(articleRoot, { recursive: true, force: true });
    return {
      internalId: article.internal_id,
      title: article.title,
      slug: article.slug,
      sourcePath: article.source_path,
    };
  }

  getGoneUrl(slug) {
    return this.db.prepare("SELECT slug, removed_at AS removedAt, reason, replacement_slug AS replacementSlug FROM gone_urls WHERE slug = ?").get(String(slug));
  }

  async deleteBySourcePath(sourcePath) {
    const article = this.db.prepare("SELECT * FROM library_articles WHERE source_path = ?").get(String(sourcePath));
    return article ? this.deleteArticle(article.internal_id) : null;
  }

  async deleteMissingSourcePaths(sourcePaths) {
    const present = new Set([...sourcePaths].map(String));
    const stale = this.db.prepare("SELECT internal_id, source_path FROM library_articles WHERE source_path IS NOT NULL").all()
      .filter((article) => !present.has(article.source_path));
    const deleted = [];
    for (const article of stale) deleted.push(await this.deleteArticle(article.internal_id));
    return deleted;
  }

  setSyncState(values) {
    const statement = this.db.prepare(`
      INSERT INTO library_sync_state(key, value, updated_at) VALUES (?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
    `);
    const now = new Date().toISOString();
    for (const [key, value] of Object.entries(values)) statement.run(key, String(value ?? ""), now);
  }

  getSyncState() {
    return Object.fromEntries(this.db.prepare("SELECT key, value FROM library_sync_state").all().map((row) => [row.key, row.value]));
  }

  exportSnapshot() {
    return {
      articles: this.db.prepare("SELECT * FROM library_articles ORDER BY id").all(),
      revisions: this.db.prepare("SELECT * FROM article_revisions ORDER BY id").all(),
      files: this.db.prepare("SELECT * FROM article_files ORDER BY id").all(),
      aliases: this.db.prepare("SELECT * FROM article_slug_aliases ORDER BY slug").all(),
      goneUrls: this.db.prepare("SELECT * FROM gone_urls ORDER BY slug").all(),
      sync: this.db.prepare("SELECT * FROM library_sync_state ORDER BY key").all(),
      derivatives: this.db.prepare("SELECT * FROM article_derivatives ORDER BY revision_id").all(),
      derivativeGenerations: this.db.prepare("SELECT * FROM article_derivative_generations ORDER BY id").all(),
      generationJobs: this.db.prepare("SELECT * FROM article_generation_jobs ORDER BY revision_id").all(),
    };
  }

  async backupFiles(snapshot) {
    const result = {};
    for (const file of snapshot.files) {
      if (!safeStoragePath(file.storage_path)) throw new Error("Invalid article storage path");
      result[`library/${file.storage_path}`] = await fs.readFile(path.join(this.rootDir, file.storage_path));
    }
    for (const generation of snapshot.derivativeGenerations || []) {
      if (!safeStoragePath(generation.artifact_root)) throw new Error("Invalid derivative artifact path");
      for (const filename of ["abstract.md", "transcript.md", "evidence.json", "generation-manifest.json"]) {
        const storagePath = path.posix.join(generation.artifact_root, filename);
        try { result[`library/${storagePath}`] = await fs.readFile(path.join(this.rootDir, storagePath)); }
        catch (error) { if (error.code !== "ENOENT") throw error; }
      }
    }
    return result;
  }

  restoreFileDescriptors(snapshot, files) {
    if (!snapshot || !Array.isArray(snapshot.articles) || !Array.isArray(snapshot.revisions) || !Array.isArray(snapshot.files)) throw new Error("Invalid article library backup");
    const descriptors = [];
    for (const file of snapshot.files) {
      if (!safeStoragePath(file.storage_path)) throw new Error("Invalid article storage path in backup");
      const data = files[`library/${file.storage_path}`];
      if (!data || data.length !== file.size || sha256(data) !== file.sha256) throw new Error(`Article file checksum mismatch: ${file.path}`);
      descriptors.push({ storagePath: file.storage_path, data });
    }
    for (const generation of snapshot.derivativeGenerations || []) {
      if (!safeStoragePath(generation.artifact_root)) throw new Error("Invalid derivative artifact path in backup");
      for (const filename of ["abstract.md", "transcript.md", "evidence.json", "generation-manifest.json"]) {
        const storagePath = path.posix.join(generation.artifact_root, filename);
        const data = files[`library/${storagePath}`];
        if (data) descriptors.push({ storagePath, data });
      }
      if (!files[`library/${path.posix.join(generation.artifact_root, "generation-manifest.json")}`]) {
        throw new Error("Derivative generation manifest is missing from backup");
      }
    }
    return descriptors;
  }

  async stageRestoreFiles(snapshot, files, targetRoot) {
    const descriptors = this.restoreFileDescriptors(snapshot, files);
    for (const item of descriptors) await atomicWrite(path.join(targetRoot, item.storagePath), item.data);
    return descriptors.map((item) => `library/${item.storagePath}`);
  }

  restoreDatabase(snapshot) {
    this.db.exec("DELETE FROM article_slug_aliases; DELETE FROM article_files; DELETE FROM article_revisions; DELETE FROM library_articles; DELETE FROM gone_urls; DELETE FROM library_sync_state;");
    const articleInsert = this.db.prepare(`INSERT INTO library_articles(id, internal_id, slug, title, source_status, published_at, revised_at, current_revision_id, published_revision_id, source_path, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    for (const row of snapshot.articles) articleInsert.run(row.id, row.internal_id, row.slug, row.title, row.source_status, row.published_at, row.revised_at, row.current_revision_id, row.published_revision_id, row.source_path, row.created_at, row.updated_at);
    const revisionInsert = this.db.prepare(`INSERT INTO article_revisions(id, article_id, revision_number, title, format, main_path, markdown_source, metadata_json, source_sha256, archive_sha256, source_kind, source_commit, state, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    for (const row of snapshot.revisions) revisionInsert.run(row.id, row.article_id, row.revision_number, row.title, row.format, row.main_path, row.markdown_source, row.metadata_json || "{}", row.source_sha256, row.archive_sha256, row.source_kind, row.source_commit, row.state, row.created_at);
    const fileInsert = this.db.prepare(`INSERT INTO article_files(id, revision_id, path, storage_path, mime, kind, size, sha256) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
    for (const row of snapshot.files) fileInsert.run(row.id, row.revision_id, row.path, row.storage_path, row.mime, row.kind, row.size, row.sha256);
    const aliasInsert = this.db.prepare("INSERT INTO article_slug_aliases(slug, article_id) VALUES (?, ?)");
    for (const row of snapshot.aliases || []) aliasInsert.run(row.slug, row.article_id);
    const goneInsert = this.db.prepare("INSERT INTO gone_urls(slug, removed_at, reason, replacement_slug) VALUES (?, ?, ?, ?)");
    for (const row of snapshot.goneUrls || []) goneInsert.run(row.slug, row.removed_at, row.reason, row.replacement_slug);
    const syncInsert = this.db.prepare("INSERT INTO library_sync_state(key, value, updated_at) VALUES (?, ?, ?)");
    for (const row of snapshot.sync || []) syncInsert.run(row.key, row.value, row.updated_at);
    const derivativeInsert = this.db.prepare(`
      INSERT INTO article_derivatives(revision_id, generation_key, source_sha256, provider, model, prompt_version,
        description, abstract_markdown, transcript_markdown, evidence_json, warnings_json, manifest_json,
        abstract_path, transcript_path, evidence_path, manifest_path, generated_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const row of snapshot.derivatives || []) derivativeInsert.run(
      row.revision_id, row.generation_key, row.source_sha256, row.provider, row.model, row.prompt_version,
      row.description, row.abstract_markdown, row.transcript_markdown, row.evidence_json, row.warnings_json,
      row.manifest_json, row.abstract_path, row.transcript_path, row.evidence_path, row.manifest_path,
      row.generated_at, row.updated_at,
    );
    const generationInsert = this.db.prepare(`
      INSERT INTO article_derivative_generations(id, revision_id, generation_key, source_sha256, provider, model,
        prompt_version, manifest_json, artifact_root, generated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const row of snapshot.derivativeGenerations || []) generationInsert.run(
      row.id, row.revision_id, row.generation_key, row.source_sha256, row.provider, row.model,
      row.prompt_version, row.manifest_json, row.artifact_root, row.generated_at,
    );
    const jobInsert = this.db.prepare(`
      INSERT INTO article_generation_jobs(revision_id, status, attempts, last_error, usage_json, next_attempt_at, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const row of snapshot.generationJobs || []) jobInsert.run(
      row.revision_id, row.status === "running" ? "pending" : row.status, row.attempts,
      row.last_error, row.usage_json, row.next_attempt_at, row.created_at, row.updated_at,
    );
    for (const table of ["library_articles", "article_revisions", "article_files", "article_derivative_generations"]) {
      this.db.prepare("DELETE FROM sqlite_sequence WHERE name = ?").run(table);
      const maximum = this.db.prepare(`SELECT COALESCE(MAX(id), 0) AS value FROM ${table}`).get().value;
      if (maximum) this.db.prepare("INSERT INTO sqlite_sequence(name, seq) VALUES (?, ?)").run(table, maximum);
    }
  }

  async restoreSnapshot(snapshot, files) {
    const temporaryRoot = `${this.rootDir}.restore-${process.pid}-${crypto.randomBytes(4).toString("hex")}`;
    await fs.mkdir(temporaryRoot, { recursive: true });
    try {
      await this.stageRestoreFiles(snapshot, files, temporaryRoot);
      this.restoreDatabase(snapshot);
    } finally {
      await fs.rm(temporaryRoot, { recursive: true, force: true });
    }
  }
}
