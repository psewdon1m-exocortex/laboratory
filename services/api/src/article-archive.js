import crypto from "node:crypto";
import path from "node:path";
import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";

export const ARTICLE_ID_PATTERN = /^l-[0-9A-HJKMNP-TV-Z]{12}$/;
export const MAX_ARTICLE_ARCHIVE_BYTES = 95 * 1024 * 1024;
export const MAX_ARTICLE_UNCOMPRESSED_BYTES = 240 * 1024 * 1024;
export const MAX_ARTICLE_ENTRIES = 256;

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const VALID_STATUSES = new Set(["published", "unpublished"]);

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function safePath(value) {
  const normalized = String(value ?? "").replaceAll("\\", "/").replace(/^\.\//, "");
  const parts = normalized.split("/");
  if (!normalized || normalized.startsWith("/") || /^[A-Za-z]:/.test(normalized)
      || parts.some((part) => !part || part === "." || part === ".." || part.startsWith("."))) {
    throw new Error(`Unsafe article path: ${value}`);
  }
  if (normalized.length > 240 || parts.some((part) => part.length > 120)) {
    throw new Error(`Article path is too long: ${value}`);
  }
  return normalized;
}

function stripSingleRoot(entries) {
  const names = Object.keys(entries).filter((name) => !name.endsWith("/"));
  const firstParts = names.map((name) => name.replaceAll("\\", "/").split("/")[0]);
  const root = firstParts.length && firstParts.every((part) => part === firstParts[0]) && names.every((name) => name.includes("/"))
    ? firstParts[0]
    : "";
  const normalized = new Map();
  for (const [rawName, bytes] of Object.entries(entries)) {
    if (rawName.endsWith("/")) continue;
    const withoutRoot = root ? rawName.replaceAll("\\", "/").slice(root.length + 1) : rawName;
    const name = safePath(withoutRoot);
    const key = name.toLocaleLowerCase("en-US");
    if ([...normalized.keys()].some((candidate) => candidate.toLocaleLowerCase("en-US") === key)) {
      throw new Error(`Duplicate article path: ${name}`);
    }
    normalized.set(name, Buffer.from(bytes));
  }
  return normalized;
}

function textFile(buffer, name, maximum = 2 * 1024 * 1024) {
  if (!buffer?.length) throw new Error(`${name} is empty`);
  if (buffer.length > maximum) throw new Error(`${name} is too large`);
  let value;
  try { value = new TextDecoder("utf-8", { fatal: true }).decode(buffer); }
  catch { throw new Error(`${name} must be valid UTF-8`); }
  if (value.includes("\0")) throw new Error(`${name} contains invalid characters`);
  return value.replace(/^\uFEFF/, "");
}

function titleFromArchive(archiveName) {
  let name = path.basename(String(archiveName || "article.zip")).replace(/\.zip$/i, "");
  try { name = decodeURIComponent(name); } catch {}
  name = name.normalize("NFC").trim();
  if (!name || name.length > 160 || /[\u0000-\u001f\u007f/\\]/.test(name)) {
    throw new Error("The archive filename must contain a 1-160 character article title");
  }
  return name;
}

function validateMainFile(entries) {
  const candidates = [...entries.keys()].filter((name) => /^(article\.md|article\.pdf)$/i.test(name));
  if (candidates.length !== 1) throw new Error("The archive must contain exactly one article.md or article.pdf at its root");
  const mainPath = candidates[0];
  const bytes = entries.get(mainPath);
  if (/\.pdf$/i.test(mainPath)) {
    if (bytes.subarray(0, 5).toString("ascii") !== "%PDF-") throw new Error("article.pdf is not a valid PDF file");
    return { format: "pdf", mainPath, markdownSource: null };
  }
  return { format: "markdown", mainPath, markdownSource: textFile(bytes, "article.md") };
}

function validateMetadata(entries) {
  const entry = [...entries.entries()].find(([name]) => name.toLowerCase() === "metadata.json");
  if (!entry) return {};
  let value;
  try { value = JSON.parse(textFile(entry[1], "metadata.json", 128 * 1024)); }
  catch (error) { throw new Error(`metadata.json is invalid: ${error.message}`); }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("metadata.json must contain an object");
  const allowed = new Set(["schema", "description", "sources"]);
  const unknown = Object.keys(value).filter((key) => !allowed.has(key));
  if (unknown.length) throw new Error(`metadata.json contains unsupported fields: ${unknown.join(", ")}`);
  const metadata = {};
  if (value.schema != null && value.schema !== "article.metadata.v1") throw new Error("metadata.json has an unsupported schema");
  if (value.description != null) {
    const description = String(value.description).normalize("NFC").trim();
    if (!description || description.length > 320) throw new Error("metadata description must contain 1-320 characters");
    metadata.description = description;
  }
  if (value.sources != null) {
    if (!Array.isArray(value.sources) || value.sources.length > 100) throw new Error("metadata sources must be an array with at most 100 items");
    metadata.sources = value.sources.map((source) => {
      if (typeof source === "string") {
        const url = source.trim();
        if (!/^https?:\/\//i.test(url) || url.length > 2_000) throw new Error("metadata source URLs must use HTTP or HTTPS");
        return { url };
      }
      if (!source || typeof source !== "object" || Array.isArray(source)) throw new Error("metadata source must be a URL or object");
      const url = String(source.url ?? "").trim();
      const title = String(source.title ?? "").normalize("NFC").trim();
      if (!/^https?:\/\//i.test(url) || url.length > 2_000) throw new Error("metadata source URL is invalid");
      if (title.length > 240) throw new Error("metadata source title is too long");
      return title ? { title, url } : { url };
    });
  }
  return metadata;
}

function semanticDigest(entries) {
  const hash = crypto.createHash("sha256");
  for (const [name, bytes] of [...entries.entries()].filter(([name]) => name.toLowerCase() !== "_id.txt").sort(([a], [b]) => a.localeCompare(b))) {
    hash.update(String(Buffer.byteLength(name)));
    hash.update(":");
    hash.update(name);
    hash.update(":");
    hash.update(String(bytes.length));
    hash.update(":");
    hash.update(bytes);
  }
  return hash.digest("hex");
}

export function generateArticleId(now = Date.now(), random = crypto.randomBytes(2)) {
  let timestamp = BigInt(now);
  let prefix = "";
  for (let index = 0; index < 10; index += 1) {
    prefix = CROCKFORD[Number(timestamp & 31n)] + prefix;
    timestamp >>= 5n;
  }
  const suffixValue = ((random[0] << 8) | random[1]) & 1023;
  return `l-${prefix}${CROCKFORD[(suffixValue >> 5) & 31]}${CROCKFORD[suffixValue & 31]}`;
}

export function detectArticleMime(name, bytes) {
  const extension = path.extname(name).toLowerCase();
  if (extension === ".pdf" && bytes.subarray(0, 5).toString("ascii") === "%PDF-") return "application/pdf";
  if (extension === ".md" || extension === ".txt") return "text/plain; charset=utf-8";
  if (extension === ".png" && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "image/png";
  if ([".jpg", ".jpeg"].includes(extension) && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (extension === ".gif" && ["GIF87a", "GIF89a"].includes(bytes.subarray(0, 6).toString("ascii"))) return "image/gif";
  if (extension === ".webp" && bytes.subarray(0, 4).toString("ascii") === "RIFF" && bytes.subarray(8, 12).toString("ascii") === "WEBP") return "image/webp";
  if (extension === ".avif" && bytes.subarray(4, 12).toString("ascii").includes("ftypavif")) return "image/avif";
  if (extension === ".mp3" && (bytes.subarray(0, 3).toString("ascii") === "ID3" || (bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0))) return "audio/mpeg";
  if (extension === ".wav" && bytes.subarray(0, 4).toString("ascii") === "RIFF" && bytes.subarray(8, 12).toString("ascii") === "WAVE") return "audio/wav";
  if (extension === ".ogg" && bytes.subarray(0, 4).toString("ascii") === "OggS") return "application/ogg";
  if ([".mp4", ".m4v", ".m4a"].includes(extension) && bytes.subarray(4, 8).toString("ascii") === "ftyp") {
    return extension === ".m4a" ? "audio/mp4" : "video/mp4";
  }
  if (extension === ".webm" && bytes.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]))) return "video/webm";
  if (extension === ".onode" || name.toLowerCase().endsWith(".onode.json")) return "application/vnd.open-node.project";
  return "application/octet-stream";
}

export function parseArticleArchive(buffer, options = {}) {
  if (!buffer?.length || buffer.length > MAX_ARTICLE_ARCHIVE_BYTES) throw new Error("Article archive is empty or exceeds the 95 MB GitHub limit");
  let count = 0;
  let uncompressed = 0;
  const entriesObject = unzipSync(new Uint8Array(buffer), {
    filter(info) {
      count += 1;
      uncompressed += info.originalSize;
      if (count > MAX_ARTICLE_ENTRIES) throw new Error(`Article archive contains more than ${MAX_ARTICLE_ENTRIES} entries`);
      if (uncompressed > MAX_ARTICLE_UNCOMPRESSED_BYTES) throw new Error("Article archive expands beyond 240 MB");
      if (info.size > 0 && info.originalSize / info.size > 200) throw new Error(`Suspicious compression ratio in ${info.name}`);
      return true;
    },
  });
  const entries = stripSingleRoot(entriesObject);
  if (!entries.size) throw new Error("Article archive contains no files");
  const status = String(options.status || "published").toLowerCase();
  if (!VALID_STATUSES.has(status)) throw new Error("Article status must be published or unpublished");
  const idEntry = [...entries.entries()].find(([name]) => name.toLowerCase() === "_id.txt");
  const internalId = idEntry ? textFile(idEntry[1], "_id.txt", 128).trim().toUpperCase().replace(/^L-/, "l-") : null;
  if (internalId && !ARTICLE_ID_PATTERN.test(internalId)) throw new Error("_id.txt does not contain a valid Laboratory article ID");
  const main = validateMainFile(entries);
  const metadata = validateMetadata(entries);
  const files = [...entries.entries()].filter(([name]) => !["_id.txt", "metadata.json"].includes(name.toLowerCase())).map(([name, bytes]) => ({
    path: name,
    bytes,
    mime: detectArticleMime(name, bytes),
    size: bytes.length,
    sha256: sha256(bytes),
    kind: name === main.mainPath ? "main" : name.startsWith("media/") ? "media" : name.startsWith("attachments/") ? "attachment" : "other",
  }));
  for (const file of files) {
    if (file.kind === "other") throw new Error(`Files must be article.md/article.pdf, media/* or attachments/*: ${file.path}`);
  }
  return {
    internalId,
    title: options.title ? titleFromArchive(`${options.title}.zip`) : titleFromArchive(options.archiveName),
    status,
    format: main.format,
    mainPath: main.mainPath,
    markdownSource: main.markdownSource,
    metadata,
    files,
    sourceSha256: semanticDigest(entries),
    archiveSha256: sha256(buffer),
  };
}

export function buildArticleArchive(article) {
  const files = { "_id.txt": strToU8(`${article.internalId}\n`) };
  if (article.metadata && Object.keys(article.metadata).length) {
    files["metadata.json"] = strToU8(`${JSON.stringify({ schema: "article.metadata.v1", ...article.metadata }, null, 2)}\n`);
  }
  for (const file of article.files) files[safePath(file.path)] = new Uint8Array(file.bytes);
  return Buffer.from(zipSync(files, { level: 6 }));
}

export function parseOpenNodeProject(bytes, filename = "workflow.onode") {
  let project;
  if (filename.toLowerCase().endsWith(".json")) {
    project = JSON.parse(textFile(bytes, filename, 12 * 1024 * 1024));
  } else {
    let expanded = 0;
    const entries = unzipSync(new Uint8Array(bytes), {
      filter(info) {
        expanded += info.originalSize;
        if (expanded > 32 * 1024 * 1024) throw new Error("Open Node project expands beyond 32 MB");
        return info.name === "project.json";
      },
    });
    if (!entries["project.json"]) throw new Error("Open Node package does not contain project.json");
    project = JSON.parse(textFile(Buffer.from(entries["project.json"]), "project.json", 12 * 1024 * 1024));
  }
  if (!project || project.format !== "open-node-project" || !Array.isArray(project.nodes) || !Array.isArray(project.connections)) {
    throw new Error("Invalid Open Node project");
  }
  return project;
}
