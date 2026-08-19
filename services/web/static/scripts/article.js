import { renderPdf } from "./pdf-renderer.js";
import { api, bindThemeControls, formatPublicationDate, pageReady } from "./shared.js";

const SCROLL_POSITION_PREFIX = "laboratory_article_scroll_v1:";

function slugFromPath() {
  const match = /^\/journal\/([^/]+)\/?$/.exec(window.location.pathname);
  return match ? decodeURIComponent(match[1]) : "";
}

function scrollStorageKey(slug) {
  return `${SCROLL_POSITION_PREFIX}${slug}`;
}

function isPageReload() {
  const navigation = performance.getEntriesByType?.("navigation")?.[0];
  if (navigation) return navigation.type === "reload";
  return performance.navigation?.type === 1;
}

function readScrollPosition(slug) {
  if (!isPageReload()) return null;
  try {
    const value = JSON.parse(sessionStorage.getItem(scrollStorageKey(slug)) || "null");
    if (!value || !Number.isFinite(value.y) || !Number.isFinite(value.progress)) return null;
    return value;
  } catch {
    return null;
  }
}

function saveScrollPosition(slug) {
  const maximum = Math.max(0, document.documentElement.scrollHeight - window.innerHeight);
  const value = {
    y: Math.max(0, window.scrollY),
    progress: maximum > 0 ? Math.max(0, Math.min(1, window.scrollY / maximum)) : 0,
    savedAt: Date.now(),
  };
  try { sessionStorage.setItem(scrollStorageKey(slug), JSON.stringify(value)); } catch {}
}

function persistScrollPosition(slug) {
  let frame = 0;
  const save = () => {
    frame = 0;
    saveScrollPosition(slug);
  };
  window.addEventListener("scroll", () => {
    if (!frame) frame = requestAnimationFrame(save);
  }, { passive: true });
  window.addEventListener("pagehide", save);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") save();
  });
}

function restoreScrollPosition(position, documentRoot) {
  if (!position || position.y <= 0) return;
  let cancelled = false;
  const cancel = () => { cancelled = true; };
  const apply = () => {
    if (cancelled) return;
    const maximum = Math.max(0, document.documentElement.scrollHeight - window.innerHeight);
    const target = maximum >= position.y ? position.y : maximum * position.progress;
    window.scrollTo(0, Math.max(0, Math.min(maximum, target)));
    updateProgress();
  };
  window.addEventListener("wheel", cancel, { once: true, passive: true });
  window.addEventListener("touchstart", cancel, { once: true, passive: true });
  window.addEventListener("pointerdown", cancel, { once: true, passive: true });
  window.addEventListener("keydown", cancel, { once: true });
  requestAnimationFrame(() => requestAnimationFrame(apply));
  for (const delay of [80, 220, 500, 900, 1500]) window.setTimeout(apply, delay);
  document.fonts?.ready?.then(apply).catch(() => {});
  for (const media of documentRoot.querySelectorAll("img, video, audio")) {
    if (media instanceof HTMLImageElement && media.complete) continue;
    media.addEventListener("loadeddata", apply, { once: true });
    media.addEventListener("load", apply, { once: true });
  }
}

function updateProgress() {
  const maximum = Math.max(1, document.documentElement.scrollHeight - window.innerHeight);
  const progress = Math.max(0, Math.min(1, window.scrollY / maximum));
  document.querySelector("[data-reading-progress]").style.transform = `scaleX(${progress})`;
}

function appendDerivedDetails(root, label, sourceHtml, headingPattern) {
  if (!sourceHtml) return;
  const details = document.createElement("details");
  details.className = "article-abstract";
  const summary = document.createElement("summary");
  summary.textContent = label;
  const body = document.createElement("div");
  body.className = "article-abstract-body";
  body.innerHTML = sourceHtml;
  const firstElement = body.firstElementChild;
  if (firstElement && headingPattern.test(firstElement.textContent.trim())) firstElement.remove();
  details.append(summary, body);
  root.append(details);
}

function renderDerivedContent(root, article) {
  root.replaceChildren();
  if (!article.abstractHtml && !(article.format === "pdf" && article.transcriptHtml)) {
    root.hidden = true;
    return;
  }
  root.hidden = false;
  appendDerivedDetails(root, "Abstract", article.abstractHtml, /^abstract$/i);
  if (article.format === "pdf") appendDerivedDetails(root, "Text version", article.transcriptHtml, /^(?:generated\s+)?transcript$/i);
}

async function initialize() {
  bindThemeControls();
  const slug = slugFromPath();
  if (!slug) throw new Error("Article not found");
  if ("scrollRestoration" in history) history.scrollRestoration = "manual";
  const savedScrollPosition = readScrollPosition(slug);
  const [content, article] = await Promise.all([
    api("/api/content"),
    api(`/api/articles/${encodeURIComponent(slug)}`),
  ]);
  document.querySelector("[data-article-title]").textContent = article.title;
  const date = document.querySelector("[data-article-date]");
  date.textContent = formatPublicationDate(article.publishedAt, article.revisedAt);
  document.title = `${article.title} — ${content.siteTitle}`;
  const back = document.querySelector("[data-article-back]");
  back.textContent = `← Back to ${content.pages.journal.title}`;
  back.addEventListener("click", (event) => {
    if (history.length > 1 && document.referrer.startsWith(location.origin)) {
      event.preventDefault();
      history.back();
    }
  });
  const root = document.querySelector("[data-article-document]");
  if (article.format === "markdown") {
    root.classList.add("article-markdown");
    root.innerHTML = article.bodyHtml || "";
    if (root.querySelector("[data-workflow-src]")) {
      const { initializeWorkflowViewers } = await import("./open-node-viewer.js");
      initializeWorkflowViewers(root);
    }
  } else {
    await renderPdf(article.pdfUrl, root, {
      width: Math.min(1240, Math.max(280, window.innerWidth - (window.innerWidth < 760 ? 24 : 120))),
    });
  }
  renderDerivedContent(document.querySelector("[data-article-abstract]"), article);
  window.addEventListener("scroll", updateProgress, { passive: true });
  window.addEventListener("resize", updateProgress);
  document.querySelector("[data-back-to-top]").addEventListener("click", () => {
    window.scrollTo({
      top: 0,
      behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth",
    });
  });
  updateProgress();
  pageReady();
  persistScrollPosition(slug);
  restoreScrollPosition(savedScrollPosition, root);
}

initialize().catch((error) => {
  console.error(error);
  document.querySelector("[data-article-error]").hidden = false;
  pageReady();
});
