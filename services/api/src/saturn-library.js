import crypto from "node:crypto";
import path from "node:path";
import { detectArticleMime } from "./article-archive.js";

const SHARE_TOKEN = /^[A-Za-z0-9_-]{43}$/;
const MAX_FILES = 255;
const MAX_DEPTH = 12;
const MAX_TOTAL_BYTES = 90 * 1024 * 1024;
const MAX_REMOTE_ASSET_BYTES = 20 * 1024 * 1024 * 1024;
const MAX_REMOTE_TOTAL_BYTES = 100 * 1024 * 1024 * 1024;
const MAX_JSON_BYTES = 1024 * 1024;

function safePart(value) {
  const part = String(value ?? "").normalize("NFC").trim();
  if (!part || part === "." || part === ".." || part.startsWith(".") || part.length > 120 || /[\u0000-\u001f\u007f/\\]/.test(part)) {
    throw new Error(`Unsafe Saturn folder entry: ${value}`);
  }
  return part;
}

async function boundedBuffer(response, maximum, label) {
  const declared = Number(response.headers.get("content-length") || 0);
  if (declared > maximum) throw new Error(`${label} exceeds the configured size limit`);
  const chunks = [];
  let length = 0;
  if (!response.body) return Buffer.alloc(0);
  for await (const chunk of response.body) {
    const value = Buffer.from(chunk);
    length += value.length;
    if (length > maximum) throw new Error(`${label} exceeds the configured size limit`);
    chunks.push(value);
  }
  return Buffer.concat(chunks, length);
}

function normalizedOrigin(value) {
  if (!value) return "";
  const url = new URL(value);
  if (url.protocol !== "https:" || !url.hostname || url.username || url.password || url.pathname !== "/") {
    throw new Error("Saturn URL must be an HTTPS origin without credentials or a path");
  }
  return url.origin;
}

function shareReference(sharedUrl, expectedOrigin) {
  const url = new URL(String(sharedUrl || ""));
  if (url.origin !== expectedOrigin || url.username || url.password || url.search || url.hash) throw new Error("The first Markdown line must be a share URL from the registered Saturn origin");
  const match = /^\/s\/([A-Za-z0-9_-]{43})\/?$/.exec(url.pathname);
  if (!match || !SHARE_TOKEN.test(match[1])) throw new Error("The first Markdown line is not a valid Saturn folder share URL");
  return { token: match[1], url: `${url.origin}/s/${match[1]}` };
}

function targetPath(relativePath, mime) {
  const normalized = relativePath.replaceAll("\\", "/");
  if (/^(media|attachments)\//.test(normalized)) return normalized;
  const isMedia = mime.startsWith("image/") || mime.startsWith("audio/") || mime.startsWith("video/")
    || mime === "application/ogg" || mime === "application/vnd.open-node.project";
  return `${isMedia ? "media" : "attachments"}/${normalized}`;
}

function hintedMime(name, declared = "") {
  if (declared) return String(declared).toLowerCase();
  const extension = path.extname(name).toLowerCase();
  if ([".png", ".jpg", ".jpeg", ".gif", ".webp", ".avif"].includes(extension)) return `image/${extension === ".jpg" ? "jpeg" : extension.slice(1)}`;
  if (extension === ".mp4") return "video/mp4";
  if (extension === ".webm") return "video/webm";
  if (extension === ".mp3") return "audio/mpeg";
  if (extension === ".wav") return "audio/wav";
  if (extension === ".pdf") return "application/pdf";
  if (extension === ".onode" || name.toLowerCase().endsWith(".onode.json")) return "application/vnd.open-node.project";
  return "application/octet-stream";
}

export class SaturnArticleBundleClient {
  constructor(config, register, fetchImpl = globalThis.fetch) {
    this.config = config;
    this.register = register;
    this.fetchImpl = fetchImpl;
  }

  get origin() {
    return normalizedOrigin(this.register.state.saturnUrl || this.config.saturnUrl || "");
  }

  status() {
    return { configured: Boolean(this.origin), origin: this.origin, clientTokenConfigured: Boolean(this.config.saturnClientToken), localAssetMaxBytes: this.config.localAssetMaxBytes };
  }

  async publishRemoteAssets(reference, descriptors) {
    if (!this.config.saturnClientToken) throw new Error("LABORATORY_SATURN_CLIENT_TOKEN is required for Saturn assets above the local threshold");
    const response = await this.fetchImpl(`${this.origin}/api/v1/laboratory/imports/from-share`, {
      method: "POST",
      headers: { Authorization: `Bearer ${this.config.saturnClientToken}`, "Content-Type": "application/json", Accept: "application/json", "User-Agent": `exocortex-laboratory/${this.config.version}` },
      body: JSON.stringify({ shareToken: reference.token, files: descriptors.map((file) => ({ resourceId: file.id, expectedSha256: file.expectedSha256, path: file.articlePath, disposition: file.articlePath.startsWith("attachments/") ? "attachment" : "inline" })) }),
      redirect: "manual",
      signal: AbortSignal.timeout(this.config.saturnTimeoutMs),
    });
    if (!response.ok) throw new Error(`Saturn publication snapshot returned HTTP ${response.status}`);
    const bytes = await boundedBuffer(response, MAX_JSON_BYTES, "Saturn publication snapshot");
    let payload;
    try { payload = JSON.parse(bytes.toString("utf8")); } catch { throw new Error("Saturn publication snapshot is invalid JSON"); }
    if (payload?.schema !== "saturn.laboratory.snapshot.v1" || !Array.isArray(payload.files) || payload.files.length !== descriptors.length) throw new Error("Saturn publication snapshot is invalid");
    return payload;
  }

  async request(url, { cookie = "", maximum = MAX_JSON_BYTES, label = "Saturn response" } = {}) {
    const target = new URL(url);
    if (target.origin !== this.origin) throw new Error("Saturn request escaped the registered origin");
    const response = await this.fetchImpl(target, {
      headers: {
        Accept: "application/json",
        "User-Agent": `exocortex-laboratory/${this.config.version}`,
        ...(cookie ? { Cookie: cookie } : {}),
      },
      redirect: "manual",
      signal: AbortSignal.timeout(this.config.saturnTimeoutMs),
    });
    if (response.status >= 300 && response.status < 400) throw new Error("Saturn redirects are not allowed during article import");
    if (!response.ok) throw new Error(`Saturn returned HTTP ${response.status} for ${label}`);
    const bytes = await boundedBuffer(response, maximum, label);
    return { response, bytes };
  }

  async json(url, options = {}) {
    const result = await this.request(url, options);
    let value;
    try { value = JSON.parse(result.bytes.toString("utf8")); }
    catch { throw new Error(`${options.label || "Saturn response"} is not valid JSON`); }
    return { ...result, value };
  }

  async fetchFolder(sharedUrl) {
    const origin = this.origin;
    if (!origin) throw new Error("Saturn is not configured in Kernel Register");
    const reference = shareReference(sharedUrl, origin);
    const apiRoot = `${origin}/api/v1/public/shares/${encodeURIComponent(reference.token)}`;
    const metadata = await this.json(apiRoot, { label: "Saturn share metadata" });
    const cookie = String(metadata.response.headers.get("set-cookie") || "").split(";", 1)[0];
    const share = metadata.value;
    if (!cookie) throw new Error("Saturn did not establish a share session");
    if (share?.state !== "active" || share?.locked || share?.resourceType !== "folder" || !["browse", "download_folder"].includes(share?.mode)) {
      throw new Error("Saturn share must be an active, unlocked browseable folder share");
    }

    const pending = [{ id: share.resourceId, prefix: "", depth: 0 }];
    const visited = new Set();
    const descriptors = [];
    while (pending.length) {
      const folder = pending.shift();
      if (visited.has(folder.id)) throw new Error("Saturn share contains a folder cycle");
      visited.add(folder.id);
      if (folder.depth > MAX_DEPTH) throw new Error(`Saturn share exceeds the maximum depth of ${MAX_DEPTH}`);
      const childrenUrl = new URL(`${apiRoot}/children`);
      if (folder.id !== share.resourceId) childrenUrl.searchParams.set("parentId", folder.id);
      const listing = await this.json(childrenUrl, { cookie, label: "Saturn folder listing" });
      if (!Array.isArray(listing.value)) throw new Error("Saturn folder listing is invalid");
      for (const child of listing.value) {
        if (!child?.id || !["file", "folder"].includes(child.type)) throw new Error("Saturn folder entry is invalid");
        const relativePath = path.posix.join(folder.prefix, safePart(child.name));
        if (child.type === "folder") pending.push({ id: child.id, prefix: relativePath, depth: folder.depth + 1 });
        else {
          const sizeBytes = Number(child.sizeBytes);
          if (!Number.isSafeInteger(sizeBytes) || sizeBytes < 0 || sizeBytes > MAX_REMOTE_ASSET_BYTES) throw new Error(`Saturn file size is invalid: ${relativePath}`);
          const expectedSha256 = child.sha256 === undefined ? "" : String(child.sha256).toLowerCase();
          if (expectedSha256 && !/^[a-f0-9]{64}$/.test(expectedSha256)) throw new Error(`Saturn file checksum is invalid: ${relativePath}`);
          descriptors.push({ ...child, sizeBytes, expectedSha256, relativePath });
        }
        if (descriptors.length > MAX_FILES) throw new Error(`Saturn share contains more than ${MAX_FILES} files`);
      }
    }

    const declaredTotalBytes = descriptors.reduce((sum, descriptor) => sum + descriptor.sizeBytes, 0);
    if (!Number.isSafeInteger(declaredTotalBytes) || declaredTotalBytes > MAX_REMOTE_TOTAL_BYTES) throw new Error("Saturn share exceeds the remote article asset limit");

    const files = [];
    const remoteCandidates = [];
    let localBytes = 0;
    const usedPaths = new Set();
    for (const descriptor of descriptors) {
      const declaredMime = hintedMime(descriptor.relativePath, descriptor.mimeType);
      const articlePath = targetPath(descriptor.relativePath, declaredMime);
      const collisionKey = articlePath.toLocaleLowerCase("en-US");
      if (usedPaths.has(collisionKey)) throw new Error(`Duplicate normalized Saturn article path: ${articlePath}`);
      usedPaths.add(collisionKey);
      if (descriptor.sizeBytes > this.config.localAssetMaxBytes) {
        if (!descriptor.expectedSha256) throw new Error(`Saturn did not provide a checksum for remote asset: ${descriptor.relativePath}`);
        if (declaredMime === "application/vnd.open-node.project") throw new Error(`Open Node projects above ${this.config.localAssetMaxBytes} bytes cannot be remote assets`);
        remoteCandidates.push({ ...descriptor, articlePath });
        continue;
      }
      const maximum = Math.min(MAX_TOTAL_BYTES - localBytes, descriptor.sizeBytes + 1);
      if (maximum <= 0) throw new Error("Saturn share exceeds the 90 MB article limit");
      const downloaded = await this.request(`${apiRoot}/content/${encodeURIComponent(descriptor.id)}`, { cookie, maximum, label: `Saturn file ${descriptor.relativePath}` });
      if (downloaded.bytes.length !== descriptor.sizeBytes) throw new Error(`Saturn file changed size during import: ${descriptor.relativePath}`);
      const mime = detectArticleMime(descriptor.relativePath, downloaded.bytes);
      if (targetPath(descriptor.relativePath, mime) !== articlePath) throw new Error(`Saturn MIME changed the normalized path during import: ${descriptor.relativePath}`);
      localBytes += downloaded.bytes.length;
      const sha256 = crypto.createHash("sha256").update(downloaded.bytes).digest("hex");
      if (descriptor.expectedSha256 && descriptor.expectedSha256 !== sha256) throw new Error(`Saturn file changed during import: ${descriptor.relativePath}`);
      files.push({ path: articlePath, bytes: downloaded.bytes, mime, sha256 });
    }

    const published = remoteCandidates.length ? await this.publishRemoteAssets(reference, remoteCandidates) : { snapshotId: "", files: [] };
    const byPath = new Map(published.files.map((file) => [file.path, file]));
    const remoteFiles = remoteCandidates.map((descriptor) => {
      const value = byPath.get(descriptor.articlePath);
      const asset = value?.asset;
      if (!value || !asset?.id || !value.versionId || value.sizeBytes !== descriptor.sizeBytes || value.sha256 !== descriptor.expectedSha256 || typeof value.url !== "string") {
        throw new Error(`Saturn publication snapshot does not match ${descriptor.relativePath}`);
      }
      const url = new URL(value.url);
      if (url.origin !== origin || url.username || url.password || url.search || url.hash || !url.pathname.startsWith(`/a/${encodeURIComponent(asset.id)}/`)) {
        throw new Error(`Saturn publication URL is invalid: ${descriptor.relativePath}`);
      }
      return { path: descriptor.articlePath, mime: String(value.mimeType), size: value.sizeBytes, sha256: value.sha256, storageBackend: "saturn", remoteAssetId: asset.id, remoteVersionId: value.versionId, publicUrl: url.toString() };
    });

    return {
      files,
      remoteFiles,
      manifest: {
        schema: "laboratory.import.saturn.v1",
        origin,
        shareId: String(share.id || ""),
        resourceId: String(share.resourceId),
        resourceName: String(share.resourceName || ""),
        snapshotId: String(published.snapshotId || ""),
        files: [...files.map((file) => ({ path: file.path, storage: "laboratory", size: file.bytes.length, mime: file.mime, sha256: file.sha256 })), ...remoteFiles.map((file) => ({ path: file.path, storage: "saturn", size: file.size, mime: file.mime, sha256: file.sha256, assetId: file.remoteAssetId, versionId: file.remoteVersionId }))],
      },
    };
  }
}

export { shareReference };
