import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Wyvern, WyvernError } from "./wyvern.js";
import { renderMarkdownDocument } from "./article-markdown.js";
import { normalizeEvidenceText, plainText } from "./seo.js";

const PROMPT_VERSION = "article-derivatives.v2";
const MAX_EVIDENCE_ITEMS = 12;
const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));
const SYSTEM_INSTRUCTION_PATH = path.join(MODULE_DIR, "prompts", "article-derivatives.system.txt");

const RESPONSE_SCHEMA = {
  type: "object",
  properties: {
    description: { type: "string" },
    abstractMarkdown: { type: "string" },
    transcriptMarkdown: { anyOf: [{ type: "string" }, { type: "null" }] },
    evidence: {
      type: "array",
      maxItems: MAX_EVIDENCE_ITEMS,
      items: {
        type: "object",
        properties: {
          text: { type: "string" },
          sourceLocator: { type: "string" },
          confidence: { type: "number" },
        },
        required: ["text", "sourceLocator", "confidence"],
      },
    },
    warnings: { type: "array", items: { type: "string" } },
  },
  required: ["description", "abstractMarkdown", "transcriptMarkdown", "evidence", "warnings"],
};

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

async function atomicWrite(filename, value) {
  await fs.mkdir(path.dirname(filename), { recursive: true });
  const temporary = path.join(path.dirname(filename), `.${path.basename(filename)}.${process.pid}.${crypto.randomBytes(4).toString("hex")}.tmp`);
  await fs.writeFile(temporary, value, { encoding: "utf8", mode: 0o600 });
  await fs.rename(temporary, filename);
}

function cleanMarkdown(value, name, maximum) {
  const text = String(value ?? "").normalize("NFC").trim();
  if (!text) throw new Error(`${name} is empty`);
  if (text.length > maximum) throw new Error(`${name} exceeds ${maximum} characters`);
  if (/<\/?(?:script|iframe|object|embed|form)\b/i.test(text)) throw new Error(`${name} contains unsafe HTML`);
  return text;
}

function validateResult(value, format) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Gemini returned an invalid result object");
  const abstractMarkdown = cleanMarkdown(value.abstractMarkdown, "Generated abstract", 20_000);
  const warnings = Array.isArray(value.warnings)
    ? value.warnings.slice(0, 50).map((warning) => String(warning).normalize("NFC").trim()).filter(Boolean)
    : ["Gemini returned warnings in an invalid format; the value was ignored."];
  let description = String(value.description ?? "").normalize("NFC").trim();
  if (description.length < 20 || description.length > 320) {
    const abstractText = plainText(renderMarkdownDocument(abstractMarkdown)).replace(/\s+/g, " ").trim();
    description = abstractText.length > 320 ? `${abstractText.slice(0, 319).trimEnd()}…` : abstractText;
    if (description.length < 20) throw new Error("Generated description and abstract are too short");
    warnings.push("Generated description had an invalid length and was rebuilt from the validated abstract.");
  }
  let transcriptMarkdown = value.transcriptMarkdown == null ? null : cleanMarkdown(value.transcriptMarkdown, "Generated transcript", 2_000_000);
  if (format === "pdf" && !transcriptMarkdown) throw new Error("PDF generation did not return a transcript");
  if (format === "markdown") transcriptMarkdown = null;
  const rawEvidence = Array.isArray(value.evidence) ? value.evidence : [];
  if (!Array.isArray(value.evidence)) warnings.push("Gemini returned evidence in an invalid format; evidence was withheld.");
  const evidence = [];
  let malformedEvidence = 0;
  for (const item of rawEvidence.slice(0, MAX_EVIDENCE_ITEMS)) {
    const text = String(item?.text ?? "").normalize("NFC").trim();
    const sourceLocator = String(item?.sourceLocator ?? "").normalize("NFC").trim();
    const confidence = Number(item?.confidence);
    if (text.length < 20 || text.length > 1_500 || !sourceLocator || sourceLocator.length > 240
        || !Number.isFinite(confidence) || confidence < 0 || confidence > 1) {
      malformedEvidence += 1;
      continue;
    }
    evidence.push({ text, sourceLocator, confidence });
  }
  if (malformedEvidence) warnings.push(`${malformedEvidence} malformed evidence item(s) were ignored.`);
  if (rawEvidence.length > MAX_EVIDENCE_ITEMS) warnings.push(`${rawEvidence.length - MAX_EVIDENCE_ITEMS} evidence item(s) above the ${MAX_EVIDENCE_ITEMS}-item limit were omitted.`);
  return { description, abstractMarkdown, transcriptMarkdown, evidence, warnings };
}

function tokenCoverage(source, transcript) {
  const sourceTokens = new Set(normalizeEvidenceText(source).match(/[a-z0-9]{3,}/g) || []);
  if (!sourceTokens.size) return null;
  const transcriptTokens = new Set(normalizeEvidenceText(transcript).match(/[a-z0-9]{3,}/g) || []);
  const matched = [...sourceTokens].filter((token) => transcriptTokens.has(token)).length;
  return Number((matched / sourceTokens.size).toFixed(4));
}

export function markdownSectionCatalog(source) {
  const html = renderMarkdownDocument(source || "");
  return [...html.matchAll(/<h([1-6])\b[^>]*\bid="([^"]+)"[^>]*>([\s\S]*?)<\/h\1>/gi)].map((match) => ({
    level: Number(match[1]),
    id: match[2],
    heading: plainText(match[3]).replace(/\s+/g, " ").trim().slice(0, 240),
  }));
}

async function pdfTextPages(bytes) {
  const { getDocument } = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const loading = getDocument({ data: new Uint8Array(bytes), isEvalSupported: false, useSystemFonts: true });
  const document = await loading.promise;
  const pages = [];
  try {
    for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber += 1) {
      const page = await document.getPage(pageNumber);
      const content = await page.getTextContent();
      pages.push(content.items.map((item) => item.str || "").join(" "));
      page.cleanup();
    }
  } finally {
    if (typeof document.destroy === "function") await document.destroy();
    else if (typeof loading.destroy === "function") await loading.destroy();
  }
  return pages;
}

export async function verifyEvidence(result, job, library) {
  let sourceText = "";
  let sectionIds = new Set();
  let pages = [];
  if (job.format === "markdown") {
    const html = renderMarkdownDocument(job.markdown_source || "");
    sourceText = plainText(html);
    sectionIds = new Set([...html.matchAll(/<h[1-6]\b[^>]*\bid="([^"]+)"/gi)].map((match) => match[1]));
  } else {
    const bytes = await fs.readFile(path.join(library.rootDir, job.storage_path));
    pages = await pdfTextPages(bytes).catch(() => []);
    sourceText = pages.join(" ");
  }

  const verified = [];
  let rejected = 0;
  for (const item of result.evidence) {
    const normalized = normalizeEvidenceText(item.text);
    let locatorText = sourceText;
    let locatorValid = false;
    if (job.format === "markdown") {
      const section = /^section:([a-z0-9]+(?:-[a-z0-9]+)*)$/.exec(item.sourceLocator)?.[1];
      locatorValid = Boolean(section && sectionIds.has(section));
    } else {
      const pageNumber = Number.parseInt(/^page:(\d+)$/.exec(item.sourceLocator)?.[1] || "", 10);
      locatorValid = Number.isInteger(pageNumber) && pageNumber >= 1 && pageNumber <= pages.length;
      locatorText = locatorValid ? pages[pageNumber - 1] : "";
    }
    if (!locatorValid || !normalized || !normalizeEvidenceText(locatorText).includes(normalized)) {
      rejected += 1;
      continue;
    }
    verified.push({
      ...item,
      verification: "exact-source-match",
      sourceTextHash: `sha256:${sha256(normalized)}`,
    });
  }
  const sourceCoverage = job.format === "pdf" ? tokenCoverage(sourceText, result.transcriptMarkdown || "") : 1;
  const warnings = [...result.warnings];
  if (rejected) warnings.push(`${rejected} generated evidence item(s) were rejected because the text or locator did not match the source.`);
  if (job.format === "pdf" && !pages.some((page) => normalizeEvidenceText(page))) {
    warnings.push("The PDF has no independently extractable text; generated evidence was withheld.");
  } else if (job.format === "pdf" && sourceCoverage != null && sourceCoverage < 0.7) {
    warnings.push(`Generated transcript source-token coverage is low (${Math.round(sourceCoverage * 100)}%).`);
  }
  return {
    ...result,
    evidence: verified,
    warnings,
    validation: {
      schema: true,
      evidenceSourceMatch: rejected === 0,
      verifiedEvidence: verified.length,
      unsupportedClaims: rejected,
      sourceCoverage,
    },
  };
}

function revisionLabel(number) {
  return `r${String(number).padStart(4, "0")}`;
}

export class DerivedContentRuntime {
  constructor(config, library, register) {
    this.config = config;
    this.library = library;
    this.register = register;
    this.db = library.db;
    this.timer = null;
    this.running = false;
    this.systemInstruction = "";
    this.gateway = new Wyvern({ linkFile: config.wyvernLinkFile });
  }

  safeError(error) {
    return error instanceof WyvernError ? error.code : "Article derivative processing failed; inspect source and Adapter configuration";
  }

  ensureAi() { return this.config.derivedContentEnabled ? this.gateway : null; }

  async start() {
    await this.loadSettings();
    this.enqueueMissing();
    setImmediate(() => this.tick());
    this.timer = setInterval(() => this.tick(), this.config.derivedContentIntervalSeconds * 1000);
    this.timer.unref();
  }

  async loadSettings() {
    const defaultInstruction = await fs.readFile(SYSTEM_INSTRUCTION_PATH, "utf8");
    const setting = this.db.prepare("SELECT value FROM settings WHERE key = ?");
    const insert = this.db.prepare("INSERT OR IGNORE INTO settings(key, value) VALUES (?, ?)");
    insert.run("aiPipelineEnabled", this.config.derivedContentEnabled ? "true" : "false");
    insert.run("aiSystemPrompt", defaultInstruction);
    this.config.derivedContentEnabled = setting.get("aiPipelineEnabled")?.value === "true";
    this.systemInstruction = setting.get("aiSystemPrompt")?.value || defaultInstruction;
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
  }

  status() {
    const counts = Object.fromEntries(this.db.prepare("SELECT status, COUNT(*) AS count FROM article_generation_jobs GROUP BY status").all().map((row) => [row.status, row.count]));
    const connection = this.gateway.lastStatus;
    return {
      enabled: this.config.derivedContentEnabled,
      configured: Boolean(connection.llm_ready),
      credentialSource: "wyvern",
      credentialError: connection.code || "",
      provider: "wyvern",
      model: "Selected Adapter / derivatives",
      promptVersion: this.promptVersion(),
      jobs: counts,
    };
  }

  promptVersion() {
    return `${PROMPT_VERSION}+${sha256(this.systemInstruction).slice(0, 12)}`;
  }

  settings() {
    return { ...this.status(), prompt: this.systemInstruction };
  }

  configure({ enabled, prompt }) {
    if (typeof enabled !== "boolean") throw new Error("AI pipeline enabled must be a boolean");
    const instruction = String(prompt ?? "").replace(/^\uFEFF/, "").trim();
    if (instruction.length < 40 || instruction.length > 40_000 || instruction.includes("\0")) {
      throw new Error("AI system prompt must contain 40-40000 valid characters");
    }
    const upsert = this.db.prepare("INSERT INTO settings(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value");
    this.db.exec("BEGIN IMMEDIATE");
    try {
      upsert.run("aiPipelineEnabled", enabled ? "true" : "false");
      upsert.run("aiSystemPrompt", instruction);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    this.config.derivedContentEnabled = enabled;
    this.systemInstruction = instruction;
    if (enabled) {
      this.enqueueMissing();
      setImmediate(() => this.tick());
    }
    return this.settings();
  }

  enqueueMissing() {
    const now = new Date().toISOString();
    const promptVersion = this.promptVersion();
    this.db.prepare(`
      INSERT OR IGNORE INTO article_generation_jobs(revision_id, status, attempts, next_attempt_at, created_at, updated_at)
      SELECT a.published_revision_id, 'pending', 0, ?, ?, ?
      FROM library_articles a
      LEFT JOIN article_derivatives d ON d.revision_id = a.published_revision_id AND d.prompt_version = ?
      WHERE a.source_status = 'published' AND a.published_revision_id IS NOT NULL AND d.revision_id IS NULL
    `).run(now, now, now, promptVersion);
    this.db.prepare(`
      UPDATE article_generation_jobs
      SET status = 'pending', attempts = 0, last_error = NULL, next_attempt_at = ?, updated_at = ?
      WHERE status = 'complete' AND revision_id IN (
        SELECT a.published_revision_id
        FROM library_articles a
        LEFT JOIN article_derivatives d
          ON d.revision_id = a.published_revision_id AND d.prompt_version = ?
        WHERE a.source_status = 'published' AND a.published_revision_id IS NOT NULL AND d.revision_id IS NULL
      )
    `).run(now, now, promptVersion);
  }

  regenerate(reference) {
    if (!this.config.derivedContentEnabled) throw new Error("AI pipeline is disabled in settings");
    const connection = this.gateway.lastStatus;
    if (!connection.llm_ready) throw new WyvernError("wyvern_not_ready");
    const row = this.db.prepare(`
      SELECT a.current_revision_id AS revision_id
      FROM library_articles a
      LEFT JOIN article_slug_aliases aliases ON aliases.article_id = a.id
      WHERE a.internal_id = ? OR a.slug = ? OR aliases.slug = ?
      LIMIT 1
    `).get(reference, reference, reference);
    if (!row?.revision_id) throw new Error("Article not found");
    const now = new Date().toISOString();
    this.db.prepare(`
      INSERT INTO article_generation_jobs(revision_id, status, attempts, last_error, usage_json, next_attempt_at, created_at, updated_at)
      VALUES (?, 'pending', 0, NULL, NULL, ?, ?, ?)
      ON CONFLICT(revision_id) DO UPDATE SET status = 'pending', attempts = 0, last_error = NULL,
        usage_json = NULL, next_attempt_at = excluded.next_attempt_at, updated_at = excluded.updated_at
    `).run(row.revision_id, now, now, now);
    setImmediate(() => this.tick());
    return { queued: true, revisionId: row.revision_id };
  }

  nextJob() {
    return this.db.prepare(`
      SELECT j.*, r.article_id, r.revision_number, r.title, r.format, r.markdown_source,
             r.source_sha256, r.main_path, a.internal_id, a.slug, f.storage_path, f.mime
      FROM article_generation_jobs j
      JOIN article_revisions r ON r.id = j.revision_id
      JOIN library_articles a ON a.id = r.article_id
      JOIN article_files f ON f.revision_id = r.id AND f.path = r.main_path
      WHERE j.status IN ('pending', 'failed') AND j.attempts < ? AND j.next_attempt_at <= ?
        AND a.current_revision_id = r.id
      ORDER BY j.created_at, j.revision_id
      LIMIT 1
    `).get(this.config.derivedContentMaxAttempts, new Date().toISOString());
  }

  async tick() {
    if (!this.ensureAi() || this.running || this.library.restoreInProgress) return;
    if (!(await this.gateway.status()).llm_ready || this.running) return;
    const restoreEpoch = this.library.restoreEpoch || 0;
    this.running = true;
    try {
      this.enqueueMissing();
      const job = this.nextJob();
      if (!job) return;
      const now = new Date().toISOString();
      this.db.prepare("UPDATE article_generation_jobs SET status = 'running', attempts = attempts + 1, last_error = NULL, usage_json = NULL, updated_at = ? WHERE revision_id = ?").run(now, job.revision_id);
      try {
        const result = await this.generate(job);
        if ((this.library.restoreEpoch || 0) !== restoreEpoch) return;
        await this.persist(job, result);
      } catch (error) {
        if ((this.library.restoreEpoch || 0) !== restoreEpoch) return;
        const attempts = job.attempts + 1;
        const delayMinutes = Math.min(24 * 60, 2 ** attempts * 5);
        const retryAt = new Date(Date.now() + delayMinutes * 60_000).toISOString();
        this.db.prepare("UPDATE article_generation_jobs SET status = 'failed', last_error = ?, next_attempt_at = ?, updated_at = ? WHERE revision_id = ?")
          .run(this.safeError(error), retryAt, new Date().toISOString(), job.revision_id);
      }
    } finally {
      this.running = false;
    }
  }

  async uploadedPdfPart(job) {
    const uploaded = await this.gateway.upload(path.join(this.library.rootDir, job.storage_path), job.mime || "application/pdf");
    try {
      let file = uploaded;
      for (let attempt = 0; file.state === "processing" && attempt < 60; attempt += 1) {
        await new Promise(resolve => setTimeout(resolve, 2000));
        file = await this.gateway.media(uploaded.media_id);
      }
      if (file.media_id !== uploaded.media_id || file.state !== "active") throw new WyvernError("wyvern_media_not_ready");
      return { part: { type: "media", media_id: file.media_id }, name: file.media_id };
    } catch (error) { await this.gateway.media(uploaded.media_id, "DELETE").catch(() => {}); throw error; }
  }

  async generate(job) {
    if (!this.ensureAi()) throw new WyvernError("wyvern_pipeline_disabled");
    let uploadedName = "";
    try {
      const contents = [{ type: "text", text: `Create publication derivatives for "${job.title}". Source format: ${job.format}.` }];
      if (job.format === "markdown") {
        contents.push({ type: "text", text: `SOURCE SECTION LOCATOR MAP\n${JSON.stringify(markdownSectionCatalog(job.markdown_source))}\nEND SOURCE SECTION LOCATOR MAP` });
        contents.push({ type: "text", text: `SOURCE MARKDOWN START\n${job.markdown_source}\nSOURCE MARKDOWN END` });
      } else {
        const uploaded = await this.uploadedPdfPart(job); contents.push(uploaded.part); uploadedName = uploaded.name;
      }
      const response = await this.gateway.call("POST", "/v1/generate", { data: { function: "derivatives",
        messages: [{ role: "system", content: this.systemInstruction }, { role: "user", content: contents }],
        response_format: { type: "json_schema", schema: RESPONSE_SCHEMA }, options: { temperature: 0.1 } } });
      const usage = { ...response.usage, finishReason: response.finish_reason };
      this.db.prepare("UPDATE article_generation_jobs SET usage_json = ?, updated_at = ? WHERE revision_id = ?")
        .run(JSON.stringify(usage), new Date().toISOString(), job.revision_id);
      if (response.finish_reason !== "stop" || !response.target?.model || !response.target?.driver) throw new WyvernError("wyvern_output_incomplete", 422);
      const result = { ...validateResult(response.json, job.format), usage, target: response.target, configGeneration: response.config_generation };
      return verifyEvidence(result, job, this.library);
    } finally { if (uploadedName) await this.gateway.media(uploadedName, "DELETE").catch(() => {}); }
  }

  async persist(job, result) {
    const model = result.target?.model || "unknown";
    const provider = result.target?.driver || "unknown";
    const generatedAt = new Date().toISOString();
    const promptVersion = this.promptVersion();
    const generationKey = `g-${sha256(`${job.source_sha256}:${promptVersion}:${model}:${generatedAt}:${crypto.randomBytes(8).toString("hex")}`).slice(0, 16)}`;
    const relativeRoot = path.posix.join(job.internal_id, revisionLabel(job.revision_number), "derived", generationKey);
    const abstractPath = path.posix.join(relativeRoot, "abstract.md");
    const transcriptPath = result.transcriptMarkdown ? path.posix.join(relativeRoot, "transcript.md") : null;
    const evidencePath = path.posix.join(relativeRoot, "evidence.json");
    const manifestPath = path.posix.join(relativeRoot, "generation-manifest.json");
    const manifest = {
      schema: "derived-content.v2",
      generationKey,
      sourceSha256: job.source_sha256,
      provider, model, adapter: result.target, configGeneration: result.configGeneration,
      promptVersion,
      generatedAt,
      status: "validated",
      validation: result.validation,
      warnings: result.warnings,
      usage: result.usage,
    };
    await atomicWrite(path.join(this.library.rootDir, abstractPath), `${result.abstractMarkdown}\n`);
    if (transcriptPath) await atomicWrite(path.join(this.library.rootDir, transcriptPath), `${result.transcriptMarkdown}\n`);
    await atomicWrite(path.join(this.library.rootDir, evidencePath), `${JSON.stringify(result.evidence, null, 2)}\n`);
    await atomicWrite(path.join(this.library.rootDir, manifestPath), `${JSON.stringify(manifest, null, 2)}\n`);
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.prepare(`
        INSERT INTO article_derivatives(revision_id, generation_key, source_sha256, provider, model, prompt_version, description,
          abstract_markdown, transcript_markdown, evidence_json, warnings_json, manifest_json,
          abstract_path, transcript_path, evidence_path, manifest_path, generated_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(revision_id) DO UPDATE SET generation_key = excluded.generation_key,
          source_sha256 = excluded.source_sha256, provider = excluded.provider,
          model = excluded.model, prompt_version = excluded.prompt_version, description = excluded.description,
          abstract_markdown = excluded.abstract_markdown, transcript_markdown = excluded.transcript_markdown,
          evidence_json = excluded.evidence_json, warnings_json = excluded.warnings_json, manifest_json = excluded.manifest_json,
          abstract_path = excluded.abstract_path, transcript_path = excluded.transcript_path,
          evidence_path = excluded.evidence_path, manifest_path = excluded.manifest_path,
          generated_at = excluded.generated_at, updated_at = excluded.updated_at
      `).run(job.revision_id, generationKey, job.source_sha256, provider, model, promptVersion, result.description,
        result.abstractMarkdown, result.transcriptMarkdown, JSON.stringify(result.evidence), JSON.stringify(result.warnings), JSON.stringify(manifest),
        abstractPath, transcriptPath, evidencePath, manifestPath, generatedAt, generatedAt);
      this.db.prepare(`
        INSERT INTO article_derivative_generations(revision_id, generation_key, source_sha256, provider, model,
          prompt_version, manifest_json, artifact_root, generated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(job.revision_id, generationKey, job.source_sha256, provider, model, promptVersion,
        JSON.stringify(manifest), relativeRoot, generatedAt);
      this.db.prepare("UPDATE article_generation_jobs SET status = 'complete', last_error = NULL, updated_at = ? WHERE revision_id = ?").run(generatedAt, job.revision_id);
      this.library.recordContentEvent({
        eventType: "DerivedContentUpdated",
        scope: "journal",
        entityId: job.internal_id,
        slug: job.slug,
        occurredAt: generatedAt,
      });
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
}
