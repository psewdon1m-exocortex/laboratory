import crypto from "node:crypto";
import path from "node:path";
import { MAX_ARTICLE_ARCHIVE_BYTES } from "./article-archive.js";

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
  if (url.protocol !== "https:" || url.hostname.toLowerCase() !== "github.com") throw new Error("The Laboratory content repository must be hosted on github.com");
  const parts = url.pathname.replace(/^\/|\/$/g, "").replace(/\.git$/i, "").split("/");
  if (parts.length !== 2 || parts.some((part) => !/^[A-Za-z0-9_.-]+$/.test(part))) throw new Error("Invalid GitHub content repository URL");
  return { owner: parts[0], repository: parts[1], fullName: `${parts[0]}/${parts[1]}`, url: `https://github.com/${parts[0]}/${parts[1]}` };
}

function articleLocation(filePath) {
  const normalized = String(filePath || "").replaceAll("\\", "/").replace(/^\/+/, "");
  const parts = normalized.split("/");
  if (parts.length !== 2 || !/\.zip$/i.test(parts[1]) || !STATUS_DIRECTORIES[parts[0]]) return null;
  return { path: normalized, status: STATUS_DIRECTORIES[parts[0]], archiveName: parts[1] };
}

function safeArchiveFilename(title) {
  const name = String(title || "Article").normalize("NFC").trim().replace(/[\/\\:*?"<>|\u0000-\u001f]/g, "-").replace(/\s+/g, " ").slice(0, 150);
  return `${name || "Article"}.zip`;
}

function encodeGithubPath(value) {
  return String(value).split("/").map(encodeURIComponent).join("/");
}

export class GitHubArticleLibrary {
  constructor(config, register, library) {
    this.config = config;
    this.register = register;
    this.library = library;
  }

  get repositoryUrl() { return this.register.state.contentRepositoryUrl || ""; }
  get branch() { return this.register.state.contentRepositoryBranch || ""; }
  get repository() { return this.repositoryUrl && this.branch ? repositoryCoordinates(this.repositoryUrl) : null; }

  status() {
    return {
      repositoryUrl: this.repositoryUrl,
      branch: this.branch,
      tokenConfigured: Boolean(this.config.githubToken),
      webhookConfigured: Boolean(this.config.githubWebhookSecret),
      ...this.library.getSyncState(),
    };
  }

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

  async fetchArchive(filePath, ref = this.branch) {
    const metadata = await this.metadata(filePath, ref);
    if (!metadata || Array.isArray(metadata) || metadata.type !== "file") throw new Error(`Article archive not found in GitHub: ${filePath}`);
    let buffer;
    if (metadata.encoding === "base64" && metadata.content) {
      buffer = Buffer.from(metadata.content.replace(/\s/g, ""), "base64");
    } else if (metadata.download_url) {
      const download = new URL(metadata.download_url);
      if (download.protocol !== "https:" || !download.hostname.endsWith("githubusercontent.com")) throw new Error("GitHub returned an unsafe archive download URL");
      const response = await fetch(download, { headers: this.headers(), signal: AbortSignal.timeout(this.config.githubTimeoutMs) });
      if (!response.ok) throw new Error(`GitHub archive download returned HTTP ${response.status}`);
      buffer = Buffer.from(await response.arrayBuffer());
    } else throw new Error(`GitHub did not provide article archive bytes: ${filePath}`);
    if (!buffer.length || buffer.length > MAX_ARTICLE_ARCHIVE_BYTES) throw new Error(`GitHub article archive exceeds the 95 MB limit: ${filePath}`);
    return { buffer, sha: metadata.sha };
  }

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
    const remote = await this.fetchArchive(location.path, ref);
    const result = await this.library.importArchive(remote.buffer, {
      archiveName: location.archiveName,
      status: location.status,
      sourceKind: "github",
      sourceCommit,
      sourcePath: location.path,
    });
    if (result.assignedId && this.config.githubToken) {
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

  async syncRepository(ref = this.branch) {
    const repository = this.repository;
    if (!repository) throw new Error("Laboratory content repository is not configured in Kernel Register");
    const tree = await this.request(`/repos/${encodeURIComponent(repository.owner)}/${encodeURIComponent(repository.repository)}/git/trees/${encodeURIComponent(ref)}?recursive=1`);
    if (tree.truncated) throw new Error("GitHub repository tree is too large for a safe full sync");
    const paths = (tree.tree || []).filter((entry) => entry.type === "blob").map((entry) => entry.path);
    const articlePaths = paths.filter((value) => articleLocation(value));
    const result = await this.syncPaths(articlePaths, ref, tree.sha || ref);
    result.deleted = await this.library.deleteMissingSourcePaths(articlePaths);
    return result;
  }

  async handlePush(payload) {
    const repository = this.repository;
    if (!repository) throw new Error("Laboratory content repository is not configured in Kernel Register");
    const pushedRepository = payload?.repository?.full_name || "";
    if (pushedRepository.toLowerCase() !== repository.fullName.toLowerCase()) throw Object.assign(new Error("Webhook repository does not match Kernel Register"), { status: 403 });
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
      const deleted = await this.library.deleteBySourcePath(filePath);
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
