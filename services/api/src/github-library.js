import crypto from "node:crypto";
import path from "node:path";
import { buildArticleArchive, MAX_ARTICLE_ARCHIVE_BYTES, parseArticleArchive } from "./article-archive.js";

const STATUS_DIRECTORIES = {
  published: "published",
  unpublished: "unpublished",
};

function safeCompare(left, right) {
  const a = Buffer.from(String(left || ""));
  const b = Buffer.from(String(right || ""));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function repositoryCoordinates(repositoryUrl) {
  if (!repositoryUrl) return null;
  const url = new URL(repositoryUrl);
  if (url.protocol !== "https:" || url.hostname.toLowerCase() !== "github.com" || url.port || url.username || url.password || url.search || url.hash) {
    throw new Error("The Laboratory content repository must be a canonical HTTPS github.com URL");
  }
  const parts = url.pathname.replace(/^\/|\/$/g, "").replace(/\.git$/i, "").split("/");
  if (parts.length !== 2 || parts.some((part) => !/^[A-Za-z0-9_.-]+$/.test(part))) throw new Error("Invalid GitHub content repository URL");
  return { owner: parts[0], repository: parts[1], fullName: `${parts[0]}/${parts[1]}`, url: `https://github.com/${parts[0]}/${parts[1]}` };
}

function articleLocation(filePath) {
  const normalized = String(filePath || "").replaceAll("\\", "/").replace(/^\/+/, "");
  const parts = normalized.split("/");
  const extension = path.posix.extname(parts[1] || "").toLowerCase();
  if (parts.length !== 2 || ![".zip", ".md", ".pdf"].includes(extension) || !STATUS_DIRECTORIES[parts[0]]) return null;
  return { path: normalized, status: STATUS_DIRECTORIES[parts[0]], archiveName: parts[1], sourceType: extension.slice(1) };
}

function titleFromSource(name) {
  let value = path.posix.basename(String(name || "")).replace(/\.(?:zip|md|pdf)$/i, "");
  try { value = decodeURIComponent(value); } catch {}
  value = value.normalize("NFC").trim();
  if (!value || value.length > 160 || /[\u0000-\u001f\u007f/\\]/.test(value)) throw new Error("The source filename must contain a 1-160 character article title");
  return value;
}

function markdownSource(buffer) {
  let value;
  try { value = new TextDecoder("utf-8", { fatal: true }).decode(buffer).replace(/^\uFEFF/, ""); }
  catch { throw new Error("The GitHub article Markdown must be valid UTF-8"); }
  if (value.includes("\0")) throw new Error("The GitHub article Markdown contains invalid characters");
  const lines = value.split(/\r?\n/);
  const sharedUrl = String(lines.shift() || "").trim();
  if (!/^https:\/\//i.test(sharedUrl)) throw new Error("The first Markdown line must contain the Saturn folder share URL");
  if (lines[0]?.trim() === "") lines.shift();
  const article = lines.join("\n").trim();
  if (!article) throw new Error("The Markdown article is empty after its Saturn share line");
  return { sharedUrl, article: `${article}\n` };
}

function attachRemoteFiles(parsed, remoteFiles = []) {
  const files = remoteFiles.map((file) => ({
    ...file,
    kind: file.path.startsWith("media/") ? "media" : file.path.startsWith("attachments/") ? "attachment" : "other",
  }));
  if (files.some((file) => file.kind === "other")) throw new Error("Remote Saturn assets must use media/* or attachments/* paths");
  if (!files.length) return parsed;
  const manifest = files.map(({ path: filePath, mime, size, sha256, remoteAssetId, remoteVersionId, publicUrl }) => ({ filePath, mime, size, sha256, remoteAssetId, remoteVersionId, publicUrl }))
    .sort((left, right) => left.filePath.localeCompare(right.filePath));
  const digest = crypto.createHash("sha256").update(parsed.sourceSha256).update(JSON.stringify(manifest)).digest("hex");
  return { ...parsed, files: [...parsed.files, ...files], sourceSha256: digest, archiveSha256: digest };
}

function safeArchiveFilename(title) {
  const name = String(title || "Article").normalize("NFC").trim().replace(/[\/\\:*?"<>|\u0000-\u001f]/g, "-").replace(/\s+/g, " ").slice(0, 150);
  return `${name || "Article"}.zip`;
}

function encodeGithubPath(value) {
  return String(value).split("/").map(encodeURIComponent).join("/");
}

async function boundedResponseBuffer(response, maximumBytes, label) {
  const declared = Number(response.headers.get("content-length") || 0);
  if (declared > maximumBytes) throw new Error(`${label} exceeds the size limit`);
  if (!response.body) return Buffer.alloc(0);
  const chunks = [];
  let length = 0;
  for await (const chunk of response.body) {
    const value = Buffer.from(chunk);
    length += value.length;
    if (length > maximumBytes) throw new Error(`${label} exceeds the size limit`);
    chunks.push(value);
  }
  return Buffer.concat(chunks, length);
}

export class GitHubArticleLibrary {
  constructor(config, register, library, saturn = null) {
    this.config = config;
    this.register = register;
    this.library = library;
    this.saturn = saturn;
    this.running = false;
    this.started = false;
    this.timer = null;
  }

  get repositoryUrl() { return this.register.state.contentRepositoryUrl || ""; }
  get branch() { return this.register.state.contentRepositoryBranch || ""; }
  get repository() { return this.repositoryUrl && this.branch ? repositoryCoordinates(this.repositoryUrl) : null; }

  status() {
    const importJobs = this.library.db ? Object.fromEntries(this.library.db.prepare("SELECT status, COUNT(*) AS count FROM github_import_jobs GROUP BY status").all().map((row) => [row.status, row.count])) : {};
    return {
      repositoryUrl: this.repositoryUrl,
      branch: this.branch,
      tokenConfigured: Boolean(this.config.githubToken),
      webhookConfigured: Boolean(this.config.githubWebhookSecret),
      saturn: this.saturn?.status?.() || { configured: false, origin: "" },
      importJobs,
      ...this.library.getSyncState(),
    };
  }

  start() {
    if (!this.library.db) return;
    this.started = true;
    setImmediate(() => this.tick());
    this.timer = setInterval(() => this.tick(), this.config.githubImportIntervalSeconds * 1000);
    this.timer.unref();
  }

  stop() { this.started = false; if (this.timer) clearInterval(this.timer); }

  verifyWebhook(signature, rawBody) {
    if (!this.config.githubWebhookSecret) throw Object.assign(new Error("GitHub webhook secret is not configured"), { status: 503 });
    const digest = `sha256=${crypto.createHmac("sha256", this.config.githubWebhookSecret).update(rawBody).digest("hex")}`;
    if (!safeCompare(signature, digest)) throw Object.assign(new Error("Invalid GitHub webhook signature"), { status: 401 });
    return true;
  }

  headers(extra = {}) {
    return {
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": `exocortex-laboratory/${this.config.version}`,
      ...(this.config.githubToken ? { Authorization: `Bearer ${this.config.githubToken}` } : {}),
      ...extra,
    };
  }

  async request(apiPath, options = {}) {
    const response = await fetch(`${this.config.githubApiUrl}${apiPath}`, {
      ...options,
      headers: this.headers(options.headers),
      signal: AbortSignal.timeout(this.config.githubTimeoutMs),
    });
    if (options.allow404 && response.status === 404) return null;
    if (!response.ok) {
      let detail = "";
      try { detail = (await response.json()).message || ""; } catch {}
      throw new Error(`GitHub returned HTTP ${response.status}${detail ? `: ${detail}` : ""}`);
    }
    if (response.status === 204) return null;
    return response.json();
  }

  async metadata(filePath, ref = this.branch) {
    const repository = this.repository;
    if (!repository) throw new Error("Laboratory content repository is not configured in Kernel Register");
    return this.request(`/repos/${encodeURIComponent(repository.owner)}/${encodeURIComponent(repository.repository)}/contents/${encodeGithubPath(filePath)}?ref=${encodeURIComponent(ref)}`, { allow404: true });
  }

  async fetchFile(filePath, ref = this.branch, maximumBytes = MAX_ARTICLE_ARCHIVE_BYTES) {
    const metadata = await this.metadata(filePath, ref);
    if (!metadata || Array.isArray(metadata) || metadata.type !== "file") throw new Error(`Article source not found in GitHub: ${filePath}`);
    if (Number.isSafeInteger(metadata.size) && metadata.size > maximumBytes) throw new Error(`GitHub article source exceeds the size limit: ${filePath}`);
    let buffer;
    if (metadata.encoding === "base64" && metadata.content) {
      buffer = Buffer.from(metadata.content.replace(/\s/g, ""), "base64");
    } else if (metadata.download_url) {
      const download = new URL(metadata.download_url);
      if (download.protocol !== "https:" || !(download.hostname === "raw.githubusercontent.com" || download.hostname.endsWith(".githubusercontent.com"))) throw new Error("GitHub returned an unsafe source download URL");
      const response = await fetch(download, { headers: this.headers(), redirect: "manual", signal: AbortSignal.timeout(this.config.githubTimeoutMs) });
      if (!response.ok) throw new Error(`GitHub source download returned HTTP ${response.status}`);
      buffer = await boundedResponseBuffer(response, maximumBytes, `GitHub article source ${filePath}`);
    } else throw new Error(`GitHub did not provide article source bytes: ${filePath}`);
    if (!buffer.length || buffer.length > maximumBytes) throw new Error(`GitHub article source exceeds the size limit: ${filePath}`);
    return { buffer, sha: metadata.sha };
  }

  fetchArchive(filePath, ref = this.branch) { return this.fetchFile(filePath, ref, MAX_ARTICLE_ARCHIVE_BYTES); }

  async putArchive(filePath, archive, message, knownSha = null) {
    if (!this.config.githubToken) throw new Error("LABORATORY_CONTENT_GITHUB_TOKEN is required for repository writeback");
    const repository = this.repository;
    if (!repository) throw new Error("Laboratory content repository is not configured in Kernel Register");
    const sha = knownSha ?? (await this.metadata(filePath))?.sha;
    return this.request(`/repos/${encodeURIComponent(repository.owner)}/${encodeURIComponent(repository.repository)}/contents/${encodeGithubPath(filePath)}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message, content: Buffer.from(archive).toString("base64"), branch: this.branch, ...(sha ? { sha } : {}) }),
    });
  }

  async deleteArchive(filePath, message) {
    if (!this.config.githubToken) throw new Error("LABORATORY_CONTENT_GITHUB_TOKEN is required for repository writeback");
    const repository = this.repository;
    const metadata = await this.metadata(filePath);
    if (!metadata) return;
    await this.request(`/repos/${encodeURIComponent(repository.owner)}/${encodeURIComponent(repository.repository)}/contents/${encodeGithubPath(filePath)}`, {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message, sha: metadata.sha, branch: this.branch }),
    });
  }

  async importPath(filePath, ref, sourceCommit = "") {
    const location = articleLocation(filePath);
    if (!location) return null;
    const remote = await this.fetchFile(location.path, ref, location.sourceType === "md" ? 2 * 1024 * 1024 : MAX_ARTICLE_ARCHIVE_BYTES);
    const sourceManifest = {
      schema: "laboratory.import.v1",
      github: { repository: this.repository.fullName, commit: sourceCommit || ref, path: location.path, blobSha: remote.sha },
    };
    let parsedOrBuffer = remote.buffer;
    if (location.sourceType === "md") {
      if (!this.saturn) throw new Error("Saturn article bundle support is not configured");
      const markdown = markdownSource(remote.buffer);
      const bundle = await this.saturn.fetchFolder(markdown.sharedUrl);
      const archive = buildArticleArchive({
        metadata: {},
        files: [{ path: "article.md", bytes: Buffer.from(markdown.article, "utf8") }, ...bundle.files],
      });
      parsedOrBuffer = attachRemoteFiles(parseArticleArchive(archive, { archiveName: `${titleFromSource(location.archiveName)}.zip`, status: location.status }), bundle.remoteFiles);
      sourceManifest.saturn = bundle.manifest;
    } else if (location.sourceType === "pdf") {
      const localLimit = this.config.localAssetMaxBytes || 10 * 1024 * 1024;
      if (remote.buffer.length > localLimit) {
        throw new Error(`Standalone PDFs above ${localLimit} bytes must be placed in the Saturn article folder and referenced from a Markdown source`);
      }
      const archive = buildArticleArchive({ metadata: {}, files: [{ path: "article.pdf", bytes: remote.buffer }] });
      parsedOrBuffer = parseArticleArchive(archive, { archiveName: `${titleFromSource(location.archiveName)}.zip`, status: location.status });
    }
    const result = await this.library.importArchive(parsedOrBuffer, {
      archiveName: location.archiveName,
      status: location.status,
      sourceKind: "github",
      sourceCommit,
      sourcePath: location.path,
      sourceManifest,
    });
    if (location.sourceType === "zip" && result.assignedId && this.config.githubToken) {
      await this.putArchive(location.path, result.archive, `laboratory: assign ${result.article.internalId}`, remote.sha);
    }
    return result;
  }

  async syncPaths(paths, ref, sourceCommit = "") {
    const unique = [...new Set(paths.map((value) => String(value)))].filter((value) => articleLocation(value));
    const imported = [];
    const errors = [];
    for (const filePath of unique) {
      try {
        const result = await this.importPath(filePath, ref, sourceCommit);
        if (result) imported.push({ path: filePath, id: result.article.internalId, changed: result.changed });
      } catch (error) {
        errors.push({ path: filePath, error: error.message });
      }
    }
    const syncValues = {
      lastCommit: sourceCommit || ref,
      lastSyncAt: new Date().toISOString(),
      lastError: errors.map((item) => `${item.path}: ${item.error}`).join("; "),
    };
    this.library.setSyncState(syncValues);
    return { imported, errors };
  }

  validatePush(payload) {
    const repository = this.repository;
    if (!repository) throw new Error("Laboratory content repository is not configured in Kernel Register");
    const pushedRepository = payload?.repository?.full_name || "";
    if (pushedRepository.toLowerCase() !== repository.fullName.toLowerCase()) throw Object.assign(new Error("Webhook repository does not match Kernel Register"), { status: 403 });
    if (payload?.ref && payload.ref !== `refs/heads/${this.branch}`) throw Object.assign(new Error("Webhook branch does not match Kernel Register"), { status: 403 });
    return true;
  }

  async applyRenames(before, after) {
    if (!/^[a-f0-9]{40}$/i.test(before || "") || /^0+$/.test(before) || !/^[a-f0-9]{40}$/i.test(after || "")) return [];
    const repository = this.repository;
    const comparison = await this.request(`/repos/${encodeURIComponent(repository.owner)}/${encodeURIComponent(repository.repository)}/compare/${encodeURIComponent(before)}...${encodeURIComponent(after)}`);
    const moved = [];
    for (const file of comparison?.files || []) {
      if (file?.status !== "renamed" || !articleLocation(file.previous_filename) || !articleLocation(file.filename)) continue;
      const result = this.library.moveSourcePath(file.previous_filename, file.filename);
      if (result) moved.push(result);
    }
    return moved;
  }

  async syncRepository(ref = this.branch, before = "") {
    const repository = this.repository;
    if (!repository) throw new Error("Laboratory content repository is not configured in Kernel Register");
    const moved = await this.applyRenames(before, ref);
    const tree = await this.request(`/repos/${encodeURIComponent(repository.owner)}/${encodeURIComponent(repository.repository)}/git/trees/${encodeURIComponent(ref)}?recursive=1`);
    if (tree.truncated) throw new Error("GitHub repository tree is too large for a safe full sync");
    const paths = (tree.tree || []).filter((entry) => entry.type === "blob").map((entry) => entry.path);
    const articlePaths = paths.filter((value) => articleLocation(value));
    const result = await this.syncPaths(articlePaths, ref, ref);
    result.moved = moved;
    result.deleted = await this.library.deleteMissingSourcePaths(articlePaths);
    return result;
  }

  enqueuePush(payload, deliveryId) {
    this.validatePush(payload);
    if (payload.deleted || !payload.after || /^0+$/.test(payload.after)) return { queued: false, ignored: "deleted_ref" };
    if (!/^[a-f0-9]{40}$/i.test(payload.after)) throw Object.assign(new Error("Webhook commit SHA is invalid"), { status: 400 });
    const id = String(deliveryId || "").trim();
    if (!id || id.length > 160 || /[\u0000-\u001f\u007f]/.test(id)) throw Object.assign(new Error("GitHub delivery ID is invalid"), { status: 400 });
    const now = new Date().toISOString();
    const inserted = this.library.db.prepare(`
      INSERT OR IGNORE INTO github_import_jobs(delivery_id, payload_json, commit_sha, status, attempts, next_attempt_at, created_at, updated_at)
      VALUES (?, ?, ?, 'pending', 0, ?, ?, ?)
    `).run(id, JSON.stringify(payload), payload.after, now, now, now);
    if (this.started) setImmediate(() => this.tick());
    return { queued: inserted.changes === 1, duplicate: inserted.changes === 0, deliveryId: id, commit: payload.after };
  }

  nextJob() {
    return this.library.db.prepare(`
      SELECT * FROM github_import_jobs
      WHERE status IN ('pending', 'failed') AND attempts < ? AND next_attempt_at <= ?
      ORDER BY id LIMIT 1
    `).get(this.config.githubImportMaxAttempts, new Date().toISOString());
  }

  async tick() {
    if (this.running || this.library.restoreInProgress) return;
    this.running = true;
    try {
      const job = this.nextJob();
      if (!job) return;
      const startedAt = new Date().toISOString();
      this.library.db.prepare("UPDATE github_import_jobs SET status = 'running', attempts = attempts + 1, last_error = NULL, updated_at = ? WHERE id = ?")
        .run(startedAt, job.id);
      try {
        const payload = JSON.parse(job.payload_json);
        this.validatePush(payload);
        const result = await this.syncRepository(payload.after, payload.before || "");
        if (result.errors.length) throw new Error(result.errors.map((item) => `${item.path}: ${item.error}`).join("; "));
        const completedAt = new Date().toISOString();
        this.library.db.prepare("UPDATE github_import_jobs SET status = 'complete', last_error = NULL, updated_at = ? WHERE id = ?").run(completedAt, job.id);
      } catch (error) {
        const attempts = job.attempts + 1;
        const delaySeconds = Math.min(3600, 2 ** attempts * 5);
        const retryAt = new Date(Date.now() + delaySeconds * 1000).toISOString();
        this.library.db.prepare("UPDATE github_import_jobs SET status = 'failed', last_error = ?, next_attempt_at = ?, updated_at = ? WHERE id = ?")
          .run(String(error?.message || error).slice(0, 4000), retryAt, new Date().toISOString(), job.id);
        this.library.setSyncState({ lastSyncAt: new Date().toISOString(), lastError: String(error?.message || error) });
      }
    } finally {
      this.running = false;
    }
  }

  async handlePush(payload) {
    this.validatePush(payload);
    if (payload.deleted || !payload.after || /^0+$/.test(payload.after)) return { imported: [], errors: [] };
    const changed = [];
    const removed = [];
    for (const commit of payload.commits || []) {
      changed.push(...(commit.added || []), ...(commit.modified || []));
      removed.push(...(commit.removed || []));
    }
    const result = await this.syncPaths(changed, payload.after, payload.after);
    result.deleted = [];
    for (const filePath of [...new Set(removed)].filter((value) => articleLocation(value))) {
      const deleted = this.library.archiveBySourcePath(filePath);
      if (deleted) result.deleted.push(deleted);
    }
    return result;
  }

  async writeArticle(result) {
    if (!this.config.githubToken) return { written: false, reason: "GitHub token is not configured" };
    const article = result.article;
    try {
      const directory = article.status === "published" ? "published" : "unpublished";
      const targetPath = path.posix.join(directory, safeArchiveFilename(article.title));
      const previousPath = article.sourcePath;
      await this.putArchive(targetPath, result.archive, `laboratory: publish ${article.internalId} revision ${article.revision}`);
      if (previousPath && previousPath !== targetPath) await this.deleteArchive(previousPath, `laboratory: move ${article.internalId}`);
      this.library.db.prepare("UPDATE library_articles SET source_path = ? WHERE internal_id = ?").run(targetPath, article.internalId);
      this.library.setSyncState({ lastSyncAt: new Date().toISOString(), lastError: "", pendingArticleId: "" });
      return { written: true, path: targetPath };
    } catch (error) {
      this.library.setSyncState({ lastError: error.message, pendingArticleId: article.internalId });
      return { written: false, error: error.message, pending: true };
    }
  }

  async deleteArticle(article) {
    if (!article?.sourcePath) return { written: false, reason: "Article is not linked to a repository archive" };
    if (!this.config.githubToken) return { written: false, reason: "GitHub token is not configured" };
    await this.deleteArchive(article.sourcePath, `laboratory: delete ${article.internalId}`);
    return { written: true, path: article.sourcePath };
  }
}

export { articleLocation, repositoryCoordinates };
