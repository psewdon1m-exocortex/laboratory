import path from "node:path";
import { marked } from "marked";
import sanitizeHtml from "sanitize-html";

const DIRECTIVE_PATTERN = /^::(gallery|image|audio|video|file|workflow)\{(.+)\}\s*$/;

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;",
  })[character]);
}

function parseArguments(raw) {
  const value = raw.trim();
  const attributes = {};
  const expression = /([A-Za-z][A-Za-z0-9_-]*)\s*=\s*"([^"]*)"/g;
  let match;
  while ((match = expression.exec(value))) attributes[match[1]] = match[2];
  if (Object.keys(attributes).length) return attributes;
  return { src: value };
}

function publicAssetUrl(context, file) {
  if (file.publicUrl) return file.publicUrl;
  const encoded = file.path.split("/").map(encodeURIComponent).join("/");
  return `/api/article-assets/${encodeURIComponent(context.internalId)}/${context.revisionNumber}/${encoded}`;
}

function workflowUrl(context, filePath) {
  const encoded = filePath.split("/").map(encodeURIComponent).join("/");
  return `/api/article-workflows/${encodeURIComponent(context.internalId)}/${context.revisionNumber}/${encoded}`;
}

function fileResolver(files) {
  const exact = new Map(files.map((file) => [file.path, file]));
  return (reference) => {
    const normalized = String(reference ?? "").replaceAll("\\", "/").replace(/^\.\//, "").trim();
    if (!normalized || normalized.startsWith("/") || normalized.split("/").includes("..")) throw new Error(`Unsafe article reference: ${reference}`);
    if (exact.has(normalized)) return exact.get(normalized);
    if (!normalized.includes("/")) {
      const matches = files.filter((file) => path.posix.basename(file.path) === normalized);
      if (matches.length === 1) return matches[0];
      if (matches.length > 1) throw new Error(`Ambiguous article reference: ${reference}`);
    }
    throw new Error(`Article file not found: ${reference}`);
  };
}

function assertMedia(file, family, reference) {
  const mime = file.mime || "application/octet-stream";
  if (family === "image" && !mime.startsWith("image/")) throw new Error(`${reference} is not a supported image`);
  if (family === "audio" && !(mime.startsWith("audio/") || mime === "application/ogg")) throw new Error(`${reference} is not supported audio`);
  if (family === "video" && !(mime.startsWith("video/") || mime === "application/ogg")) throw new Error(`${reference} is not supported video`);
  if (family === "workflow" && mime !== "application/vnd.open-node.project") throw new Error(`${reference} is not an Open Node project`);
}

function directiveHtml(kind, rawArguments, files, context, referenced) {
  const argumentsValue = parseArguments(rawArguments);
  const resolve = fileResolver(files);
  const caption = argumentsValue.caption ? `<figcaption>${escapeHtml(argumentsValue.caption)}</figcaption>` : "";
  if (kind === "gallery") {
    const references = String(argumentsValue.src ?? "").split(",").map((item) => item.trim()).filter(Boolean);
    if (!references.length) throw new Error("Gallery directive must reference at least one image");
    const images = references.map((reference, index) => {
      const file = resolve(reference);
      assertMedia(file, "image", reference);
      referenced.add(file.path);
      const alt = references.length === 1 ? (argumentsValue.alt || "") : `${argumentsValue.alt || "Gallery image"} ${index + 1}`;
      return `<figure><img src="${escapeHtml(publicAssetUrl(context, file))}" alt="${escapeHtml(alt)}" loading="lazy" /></figure>`;
    }).join("");
    return `<div class="article-gallery${references.length === 1 ? " is-single" : ""}">${images}</div>${caption}`;
  }
  const reference = argumentsValue.src;
  if (!reference) throw new Error(`${kind} directive requires a file path`);
  const file = resolve(reference);
  referenced.add(file.path);
  const url = publicAssetUrl(context, file);
  if (kind === "image") {
    assertMedia(file, "image", reference);
    return `<figure class="article-image"><img src="${escapeHtml(url)}" alt="${escapeHtml(argumentsValue.alt || "")}" loading="lazy" />${caption}</figure>`;
  }
  if (kind === "audio") {
    assertMedia(file, "audio", reference);
    return `<figure class="article-audio"><audio controls preload="metadata" src="${escapeHtml(url)}"></audio>${caption}</figure>`;
  }
  if (kind === "video") {
    assertMedia(file, "video", reference);
    let poster = "";
    if (argumentsValue.poster) {
      const posterFile = resolve(argumentsValue.poster);
      assertMedia(posterFile, "image", argumentsValue.poster);
      referenced.add(posterFile.path);
      poster = ` poster="${escapeHtml(publicAssetUrl(context, posterFile))}"`;
    }
    return `<figure class="article-video"><video controls preload="metadata" playsinline src="${escapeHtml(url)}"${poster}></video>${caption}</figure>`;
  }
  if (kind === "workflow") {
    assertMedia(file, "workflow", reference);
    return `<figure class="article-workflow-frame"><div class="article-workflow" data-workflow-src="${escapeHtml(workflowUrl(context, file.path))}"><p class="article-workflow-status">Loading canvas when it approaches the viewport</p></div>${caption}</figure>`;
  }
  return `<a class="article-file" href="${escapeHtml(url)}" download><span>${escapeHtml(argumentsValue.label || path.posix.basename(file.path))}</span><small>Download · ${escapeHtml(file.mime || "file")}</small></a>`;
}

function appendAttachments(html, files, context, referenced) {
  const attachments = files.filter((file) => file.kind === "attachment" && !referenced.has(file.path));
  if (!attachments.length) return html;
  const links = attachments.map((file) => `<a class="article-file" href="${escapeHtml(publicAssetUrl(context, file))}" download><span>${escapeHtml(path.posix.basename(file.path))}</span><small>Download · ${escapeHtml(file.mime || "file")}</small></a>`).join("");
  return `${html}<section class="article-attachments"><h2>Attachments</h2>${links}</section>`;
}

function sanitize(value) {
  return sanitizeHtml(value, {
    allowedTags: [
      "p", "br", "strong", "em", "del", "blockquote", "pre", "code", "hr", "a",
      "h1", "h2", "h3", "h4", "h5", "h6", "ul", "ol", "li", "table", "thead", "tbody", "tr", "th", "td",
      "figure", "figcaption", "img", "audio", "video", "source", "div", "span", "small", "section",
    ],
    allowedAttributes: {
      "*": ["class"],
      a: ["href", "title", "download", "rel"],
      img: ["src", "alt", "title", "loading"],
      audio: ["src", "controls", "preload"],
      video: ["src", "controls", "preload", "playsinline", "poster"],
      source: ["src", "type"],
      div: ["data-workflow-src"],
    },
    allowedSchemes: ["http", "https", "mailto"],
    allowProtocolRelative: false,
    enforceHtmlBoundary: true,
    transformTags: {
      a: (tagName, attributes) => {
        if (/^https?:\/\//i.test(attributes.href || "")) attributes.rel = "noopener noreferrer";
        return { tagName, attribs: attributes };
      },
    },
  });
}

function headingSlug(value, used) {
  const base = String(value)
    .replace(/<[^>]*>/g, " ")
    .replace(/&(?:amp|lt|gt|quot|#39);/g, " ")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 72) || "section";
  let slug = base;
  let suffix = 2;
  while (used.has(slug)) slug = `${base}-${suffix++}`;
  used.add(slug);
  return slug;
}

function addStableHeadingIds(value) {
  const used = new Set();
  return value.replace(/<(h[1-6])>([\s\S]*?)<\/\1>/gi, (_match, tag, body) => (
    `<${tag} id="${headingSlug(body, used)}">${body}</${tag}>`
  ));
}

function offsetHeadings(value, offset) {
  const amount = Math.max(0, Math.min(5, Number(offset) || 0));
  if (!amount) return value;
  return value.replace(/<(\/?)h([1-6])(\b[^>]*)>/gi, (_match, closing, level, attributes) => (
    `<${closing}h${Math.min(6, Number(level) + amount)}${attributes}>`
  ));
}

export function renderMarkdownDocument(source, { headingOffset = 0 } = {}) {
  marked.use({ gfm: true, breaks: false });
  const html = offsetHeadings(marked.parse(String(source ?? ""), { async: false }), headingOffset);
  return addStableHeadingIds(sanitize(html));
}

export function renderArticleMarkdown(source, files, context) {
  const referenced = new Set(files.filter((file) => file.kind === "main").map((file) => file.path));
  const transformed = String(source).split(/\r?\n/).map((line) => {
    const match = DIRECTIVE_PATTERN.exec(line.trim());
    return match ? `\n${directiveHtml(match[1], match[2], files, context, referenced)}\n` : line;
  }).join("\n");
  marked.use({ gfm: true, breaks: false });
  let html = offsetHeadings(marked.parse(transformed, { async: false }), context.headingOffset ?? 1);
  html = appendAttachments(html, files, context, referenced);
  const warnings = files.filter((file) => file.kind === "media" && !referenced.has(file.path)).map((file) => `Unused media file: ${file.path}`);
  return { html: addStableHeadingIds(sanitize(html)), warnings, referenced: [...referenced] };
}
