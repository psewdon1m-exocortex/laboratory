import crypto from "node:crypto";
import { extractEvidencePassages } from "./seo.js";

function sha256(value) {
  return crypto.createHash("sha256").update(String(value)).digest("hex");
}

function encodeCursor(value) {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

function decodeCursor(value, fingerprint) {
  if (!value) return 0;
  try {
    const parsed = JSON.parse(Buffer.from(String(value), "base64url").toString("utf8"));
    if (parsed?.v !== 1 || parsed?.fingerprint !== fingerprint || !Number.isInteger(parsed.offset) || parsed.offset < 0) {
      throw new Error("Invalid cursor");
    }
    return parsed.offset;
  } catch {
    const error = new Error("Invalid or stale search cursor");
    error.status = 400;
    throw error;
  }
}

function ftsTerms(query) {
  return String(query || "").normalize("NFKC").match(/[\p{L}\p{N}]{2,}/gu) || [];
}

function ftsExpression(terms, mode) {
  return terms.map((term) => `"${term.replaceAll('"', '""')}"`).join(mode === "any" ? " OR " : " AND ");
}

function placeholders(values) {
  return values.map(() => "?").join(", ");
}

function rowToEvidence(row, baseUrl, language) {
  const canonicalUrl = new URL(`/journal/${encodeURIComponent(row.slug)}`, `${baseUrl}/`).toString();
  const section = /^section:(.+)$/.exec(row.source_locator || "")?.[1];
  const page = /^page:(\d+)$/.exec(row.source_locator || "")?.[1];
  const sourceUrl = row.source_url ? new URL(row.source_url, `${baseUrl}/`).toString() : canonicalUrl;
  return {
    id: row.evidence_id,
    articleId: row.article_internal_id,
    revision: row.revision_number,
    slug: row.slug,
    title: row.title,
    format: row.format,
    text: row.text,
    sourceLocator: row.source_locator,
    canonicalUrl: section ? `${canonicalUrl}#${encodeURIComponent(section)}` : canonicalUrl,
    sourceUrl: page ? `${sourceUrl}#page=${page}` : (section ? `${canonicalUrl}#${encodeURIComponent(section)}` : sourceUrl),
    publishedAt: row.published_at,
    contentModifiedAt: row.modified_at,
    language,
    confidence: row.confidence == null ? null : Number(row.confidence),
    evidenceType: "source-extract",
    verified: true,
    verification: row.verification,
    sourceTextHash: row.source_text_sha256,
    sourceHash: row.source_sha256,
    digestInput: "normalized-exposed-text",
    normalization: "laboratory-evidence-v1",
    matchScore: row.rank == null ? null : Number(Math.max(0, -Number(row.rank)).toFixed(8)),
  };
}

export function groupEvidence(items) {
  const articles = [];
  const byId = new Map();
  for (const item of items) {
    let group = byId.get(item.articleId);
    if (!group) {
      group = {
        id: item.articleId,
        revision: item.revision,
        slug: item.slug,
        title: item.title,
        format: item.format,
        canonicalUrl: item.canonicalUrl.split("#")[0],
        publishedAt: item.publishedAt,
        contentModifiedAt: item.contentModifiedAt,
        language: item.language,
        passages: [],
      };
      byId.set(item.articleId, group);
      articles.push(group);
    }
    const { articleId, revision, slug, title, format, publishedAt, contentModifiedAt, language, ...passage } = item;
    group.passages.push(passage);
  }
  return articles;
}

export class EvidenceIndex {
  constructor(store, { language = "en" } = {}) {
    this.store = store;
    this.db = store.db;
    this.language = language;
    this.initialize();
    this.synchronize();
  }

  initialize() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS public_evidence_passages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        revision_id INTEGER NOT NULL REFERENCES article_revisions(id) ON DELETE CASCADE,
        revision_number INTEGER NOT NULL,
        evidence_id TEXT NOT NULL UNIQUE,
        article_internal_id TEXT NOT NULL,
        slug TEXT NOT NULL,
        title TEXT NOT NULL,
        format TEXT NOT NULL,
        published_at TEXT NOT NULL,
        modified_at TEXT NOT NULL,
        source_url TEXT,
        source_sha256 TEXT,
        ordinal INTEGER NOT NULL,
        text TEXT NOT NULL,
        source_locator TEXT NOT NULL,
        confidence REAL,
        verification TEXT NOT NULL,
        source_text_sha256 TEXT NOT NULL,
        UNIQUE(revision_id, ordinal)
      );
      CREATE TABLE IF NOT EXISTS public_evidence_revision_state (
        revision_id INTEGER PRIMARY KEY REFERENCES article_revisions(id) ON DELETE CASCADE,
        index_key TEXT NOT NULL,
        indexed_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_public_evidence_article_revision
      ON public_evidence_passages(article_internal_id, revision_number);
      CREATE INDEX IF NOT EXISTS idx_public_evidence_modified
      ON public_evidence_passages(modified_at DESC, id DESC);
      CREATE VIRTUAL TABLE IF NOT EXISTS public_evidence_fts USING fts5(
        title,
        text,
        content='public_evidence_passages',
        content_rowid='id',
        tokenize='porter unicode61 remove_diacritics 2'
      );
      CREATE TRIGGER IF NOT EXISTS public_evidence_ai AFTER INSERT ON public_evidence_passages BEGIN
        INSERT INTO public_evidence_fts(rowid, title, text) VALUES (new.id, new.title, new.text);
      END;
      CREATE TRIGGER IF NOT EXISTS public_evidence_ad AFTER DELETE ON public_evidence_passages BEGIN
        INSERT INTO public_evidence_fts(public_evidence_fts, rowid, title, text) VALUES ('delete', old.id, old.title, old.text);
      END;
      CREATE TRIGGER IF NOT EXISTS public_evidence_au AFTER UPDATE ON public_evidence_passages BEGIN
        INSERT INTO public_evidence_fts(public_evidence_fts, rowid, title, text) VALUES ('delete', old.id, old.title, old.text);
        INSERT INTO public_evidence_fts(rowid, title, text) VALUES (new.id, new.title, new.text);
      END;
    `);
  }

  synchronize() {
    const articles = this.store.listArticles({ sort: "newest" }).map((item) => this.store.getArticle(item.slug)).filter(Boolean);
    const revisionLookup = this.db.prepare(`
      SELECT a.published_revision_id AS revisionId
      FROM library_articles a WHERE a.internal_id = ? AND a.source_status = 'published'
    `);
    const records = articles.map((article) => {
      const revisionId = revisionLookup.get(article.internalId)?.revisionId;
      const sourceFile = article.files?.find((file) => file.kind === "main");
      const indexKey = revisionId
        ? sha256(`${article.internalId}:${article.revision}:${sourceFile?.sha256 || ""}:${article.derivedContent?.generationKey || "source"}`)
        : "";
      return { article, revisionId, indexKey };
    }).filter((record) => record.revisionId);
    const currentState = new Map(this.db.prepare(
      "SELECT revision_id AS revisionId, index_key AS indexKey FROM public_evidence_revision_state",
    ).all().map((row) => [row.revisionId, row.indexKey]));
    const unchanged = currentState.size === records.length
      && records.every((record) => currentState.get(record.revisionId) === record.indexKey);
    if (unchanged) return;

    const activeRevisionIds = records.map((record) => record.revisionId);
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const stateLookup = this.db.prepare("SELECT index_key AS indexKey FROM public_evidence_revision_state WHERE revision_id = ?");
      const deletePassages = this.db.prepare("DELETE FROM public_evidence_passages WHERE revision_id = ?");
      const saveState = this.db.prepare(`
        INSERT INTO public_evidence_revision_state(revision_id, index_key, indexed_at) VALUES (?, ?, ?)
        ON CONFLICT(revision_id) DO UPDATE SET index_key = excluded.index_key, indexed_at = excluded.indexed_at
      `);
      const insertPassage = this.db.prepare(`
        INSERT INTO public_evidence_passages(
          revision_id, revision_number, evidence_id, article_internal_id, slug, title, format,
          published_at, modified_at, source_url, source_sha256, ordinal, text, source_locator,
          confidence, verification, source_text_sha256
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      for (const { article, revisionId, indexKey } of records) {
        if (stateLookup.get(revisionId)?.indexKey === indexKey) continue;
        deletePassages.run(revisionId);
        const passages = extractEvidencePassages(article);
        passages.forEach((passage, index) => insertPassage.run(
          revisionId,
          article.revision,
          passage.id,
          article.internalId,
          article.slug,
          article.title,
          article.format,
          article.publishedAt,
          article.revisedAt || article.publishedAt,
          article.pdfUrl || null,
          passage.sourceHash,
          index + 1,
          passage.text,
          passage.sourceLocator,
          passage.confidence ?? null,
          passage.verification,
          passage.sourceTextHash,
        ));
        saveState.run(revisionId, indexKey, new Date().toISOString());
      }
      if (activeRevisionIds.length) {
        const active = placeholders(activeRevisionIds);
        this.db.prepare(`DELETE FROM public_evidence_passages WHERE revision_id NOT IN (${active})`).run(...activeRevisionIds);
        this.db.prepare(`DELETE FROM public_evidence_revision_state WHERE revision_id NOT IN (${active})`).run(...activeRevisionIds);
      } else {
        this.db.exec("DELETE FROM public_evidence_passages; DELETE FROM public_evidence_revision_state;");
      }
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    this.db.exec("PRAGMA optimize");
  }

  search({ query = "", mode = "all", limit = 10, cursor = "", offset: requestedOffset = 0, format = "", updatedAfter = "", baseUrl }) {
    this.synchronize();
    const safeQuery = String(query).trim().slice(0, 200);
    const safeMode = mode === "any" ? "any" : "all";
    const safeLimit = Math.max(1, Math.min(50, Number.parseInt(limit, 10) || 10));
    const safeFormat = ["markdown", "pdf"].includes(format) ? format : "";
    const safeUpdatedAfter = /^\d{4}-\d{2}-\d{2}(?:T.*Z)?$/.test(String(updatedAfter || "")) ? String(updatedAfter) : "";
    const terms = ftsTerms(safeQuery);
    const fingerprint = sha256(JSON.stringify({ q: safeQuery.toLocaleLowerCase(this.language), mode: safeMode, format: safeFormat, updatedAfter: safeUpdatedAfter }));
    const offset = cursor
      ? decodeCursor(cursor, fingerprint)
      : Math.max(0, Math.min(10_000, Number.parseInt(requestedOffset, 10) || 0));
    if (safeQuery && !terms.length) {
      return { query: safeQuery, mode: safeMode, count: 0, total: 0, nextCursor: null, items: [], articles: [] };
    }
    const filters = [];
    const filterValues = [];
    if (safeFormat) { filters.push("p.format = ?"); filterValues.push(safeFormat); }
    if (safeUpdatedAfter) { filters.push("p.modified_at >= ?"); filterValues.push(safeUpdatedAfter); }
    const filterSql = filters.length ? ` AND ${filters.join(" AND ")}` : "";
    let rows;
    let total;
    if (terms.length) {
      const expression = ftsExpression(terms, safeMode);
      total = this.db.prepare(`
        SELECT COUNT(*) AS count FROM public_evidence_fts
        JOIN public_evidence_passages p ON p.id = public_evidence_fts.rowid
        WHERE public_evidence_fts MATCH ?${filterSql}
      `).get(expression, ...filterValues).count;
      rows = this.db.prepare(`
        SELECT p.*, bm25(public_evidence_fts, 3.0, 1.0) AS rank
        FROM public_evidence_fts JOIN public_evidence_passages p ON p.id = public_evidence_fts.rowid
        WHERE public_evidence_fts MATCH ?${filterSql}
        ORDER BY rank ASC, p.modified_at DESC, p.id ASC LIMIT ? OFFSET ?
      `).all(expression, ...filterValues, safeLimit, offset);
    } else {
      const where = filters.length ? `WHERE ${filters.join(" AND ")}` : "";
      total = this.db.prepare(`SELECT COUNT(*) AS count FROM public_evidence_passages p ${where}`).get(...filterValues).count;
      rows = this.db.prepare(`
        SELECT p.*, NULL AS rank FROM public_evidence_passages p ${where}
        ORDER BY p.modified_at DESC, p.id ASC LIMIT ? OFFSET ?
      `).all(...filterValues, safeLimit, offset);
    }
    const items = rows.map((row) => rowToEvidence(row, baseUrl, this.language));
    const nextOffset = offset + items.length;
    const nextCursor = nextOffset < total ? encodeCursor({ v: 1, fingerprint, offset: nextOffset }) : null;
    return {
      query: safeQuery,
      mode: safeMode,
      count: items.length,
      total,
      nextCursor,
      items,
      articles: groupEvidence(items),
    };
  }

  forArticle(reference, baseUrl) {
    this.synchronize();
    const article = this.store.getArticle(reference);
    if (!article) return [];
    const rows = this.db.prepare(`
      SELECT p.*, NULL AS rank FROM public_evidence_passages p
      WHERE p.article_internal_id = ? AND p.revision_number = ? ORDER BY p.ordinal
    `).all(article.internalId, article.revision);
    return rows.map((row) => rowToEvidence(row, baseUrl, this.language));
  }
}
