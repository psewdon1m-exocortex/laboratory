import { clearPdf, renderPdf } from "./pdf-renderer.js";
import {
  api,
  applySiteChrome,
  bindThemeControls,
  formatPublicationDate,
  pageReady,
  playPageTransition,
} from "./shared.js";

const shell = document.querySelector("[data-journal-shell]");
const stage = document.querySelector("[data-journal-stage]");
const index = document.querySelector("[data-journal-index]");
const rail = document.querySelector("[data-journal-rail]");
const railPath = document.querySelector("[data-journal-path]");
const railGradient = document.querySelector("[data-rail-gradient]");
const railShape = document.querySelector("[data-journal-shape]");
const railEdgeStops = [...document.querySelectorAll("[data-rail-edge-stop]")];
const list = document.querySelector("[data-journal-list]");
const empty = document.querySelector("[data-journal-empty]");
const search = document.querySelector("[data-journal-search]");
const sortButton = document.querySelector("[data-journal-sort]");
const preview = document.querySelector("[data-article-preview]");
const previewLink = document.querySelector("[data-preview-link]");
const previewTitle = document.querySelector("[data-preview-title]");
const previewDate = document.querySelector("[data-preview-date]");
const previewDocument = document.querySelector("[data-preview-document]");

const DEFAULT_LENS = {
  bendScale: 1,
  upperSpread: 1,
  lowerSpread: 1,
  upperLead: 0.32,
  lowerLead: 0.32,
  upperShoulder: 92,
  lowerShoulder: 92,
  waistDrift: 0,
  upperEdgeDrift: 0,
  lowerEdgeDrift: 0,
  upperEdgeWidth: 1.5,
  lowerEdgeWidth: 1.5,
};

function randomLens() {
  return {
    bendScale: 0.72 + Math.random() * 0.63,
    upperSpread: 0.7 + Math.random() * 0.7,
    lowerSpread: 0.7 + Math.random() * 0.7,
    upperLead: 0.18 + Math.random() * 0.3,
    lowerLead: 0.18 + Math.random() * 0.3,
    upperShoulder: 54 + Math.random() * 96,
    lowerShoulder: 54 + Math.random() * 96,
    waistDrift: -0.13 + Math.random() * 0.26,
    upperEdgeDrift: -0.28 + Math.random() * 0.56,
    lowerEdgeDrift: -0.28 + Math.random() * 0.56,
    upperEdgeWidth: 3.25 + Math.random() * 4.75,
    lowerEdgeWidth: 3.25 + Math.random() * 4.75,
  };
}

const RAIL_SAMPLE_COUNT = 128;

const state = {
  all: [],
  articles: [],
  sort: "newest",
  query: "",
  position: 0,
  selectedIndex: 0,
  selectedSlug: "",
  exploreProgress: 0,
  exploreTarget: 0,
  hasInteracted: false,
  wheelVelocity: 0,
  mouseVelocity: 0,
  pointerX: window.innerWidth,
  pointerY: window.innerHeight / 2,
  wheelAt: 0,
  previewTimer: null,
  lens: DEFAULT_LENS,
  lastFrame: performance.now(),
  mobile: matchMedia("(max-width: 760px), (pointer: coarse)").matches,
};

function orderedArticles() {
  const query = state.query.trim().toLocaleLowerCase("en");
  const items = state.all.filter((article) => article.title.toLocaleLowerCase("en").includes(query));
  return [...items].sort((left, right) => {
    const difference = new Date(left.publishedAt) - new Date(right.publishedAt);
    return state.sort === "oldest" ? difference : -difference;
  });
}

function buildList() {
  list.replaceChildren();
  state.articles = orderedArticles();
  state.position = 0;
  state.selectedIndex = 0;
  state.selectedSlug = "";
  empty.hidden = state.articles.length > 0;
  state.articles.forEach((article, articleIndex) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "journal-item";
    button.textContent = article.title;
    button.dataset.index = String(articleIndex);
    button.addEventListener("click", () => {
      if (state.mobile || articleIndex === state.selectedIndex) openArticle(article);
      else {
        state.position = articleIndex;
        commitSelection(true);
        renderGeometry();
      }
    });
    list.appendChild(button);
  });
  if (state.articles.length) commitSelection(false);
  else {
    preview.hidden = true;
    clearPdf(previewDocument);
  }
  renderGeometry();
}

function openArticle(article) {
  window.location.href = `/journal/${encodeURIComponent(article.slug)}`;
}

function selectedArticle() {
  return state.articles[state.selectedIndex] ?? null;
}

function commitSelection(showPreview) {
  if (!state.articles.length) return;
  state.selectedIndex = Math.max(0, Math.min(state.articles.length - 1, Math.round(state.position)));
  const article = selectedArticle();
  list.querySelectorAll(".journal-item").forEach((item, itemIndex) => {
    const active = itemIndex === state.selectedIndex;
    item.classList.toggle("is-selected", active);
    item.setAttribute("aria-current", active ? "true" : "false");
  });
  if (article.slug === state.selectedSlug && (!showPreview || !preview.hidden)) return;
  state.selectedSlug = article.slug;
  if (showPreview || state.hasInteracted) schedulePreview(article);
}

function schedulePreview(article) {
  clearTimeout(state.previewTimer);
  state.previewTimer = setTimeout(async () => {
    preview.hidden = false;
    shell.classList.add("has-selection");
    previewTitle.textContent = article.title;
    previewDate.textContent = formatPublicationDate(article.publishedAt, article.revisedAt);
    previewLink.href = `/journal/${encodeURIComponent(article.slug)}`;
    try {
      if (article.format === "markdown") {
        clearPdf(previewDocument);
        const detail = await api(`/api/articles/${encodeURIComponent(article.slug)}`);
        previewDocument.className = "article-preview-document article-markdown article-markdown-preview";
        previewDocument.innerHTML = detail.bodyHtml || "";
      } else {
        previewDocument.className = "article-preview-document";
        await renderPdf(article.pdfUrl, previewDocument, {
          preview: true,
          scrollRoot: preview,
          width: Math.max(280, previewDocument.clientWidth),
        });
      }
    } catch (error) {
      previewDocument.innerHTML = `<p class="pdf-loading">${error.message}</p>`;
    }
  }, 110);
}

function geometry() {
  const width = stage.clientWidth || window.innerWidth;
  const height = stage.clientHeight || window.innerHeight;
  const focusY = height * (state.mobile ? 0.14 : 0.58);
  const baseX = width * (state.mobile ? 0.075 : 0.12);
  const bend = Math.min(104, width * 0.075) * state.exploreProgress * state.lens.bendScale;
  return { width, height, focusY, baseX, bend };
}

function curveX(y, values) {
  const spreadScale = y < values.focusY ? state.lens.upperSpread : state.lens.lowerSpread;
  const spread = values.height * 0.32 * spreadScale;
  const distance = (y - values.focusY) / spread;
  const drift = state.lens.waistDrift * distance;
  const edgeDrift = y < values.focusY ? state.lens.upperEdgeDrift : state.lens.lowerEdgeDrift;
  const edgeInfluence = Math.min(1, Math.abs(distance) ** 1.4);
  return values.baseX + values.bend * edgeDrift * edgeInfluence
    - values.bend * Math.exp(-((distance - drift) ** 2) * 1.4);
}

function renderRailShape(values, top, bottom) {
  const length = railPath.getTotalLength();
  railShape.style.display = "";
  railPath.style.opacity = "0";
  railGradient.setAttribute("y1", String(top));
  railGradient.setAttribute("y2", String(bottom));
  const edgeOpacity = String(1 - state.exploreProgress);
  for (const stop of railEdgeStops) stop.setAttribute("stop-opacity", edgeOpacity);
  const centerline = Array.from({ length: RAIL_SAMPLE_COUNT + 1 }, (_, index) => (
    railPath.getPointAtLength((index / RAIL_SAMPLE_COUNT) * length)
  ));
  const left = [];
  const right = [];
  centerline.forEach((point, index) => {
    const previous = centerline[Math.max(0, index - 1)];
    const next = centerline[Math.min(RAIL_SAMPLE_COUNT, index + 1)];
    const tangentX = next.x - previous.x;
    const tangentY = next.y - previous.y;
    const tangentLength = Math.hypot(tangentX, tangentY) || 1;
    const normalX = -tangentY / tangentLength;
    const normalY = tangentX / tangentLength;
    const upper = point.y < values.focusY;
    const sideLength = upper ? values.focusY - top : bottom - values.focusY;
    const distance = Math.min(1, Math.abs(point.y - values.focusY) / Math.max(1, sideLength));
    const edgeWidth = upper ? state.lens.upperEdgeWidth : state.lens.lowerEdgeWidth;
    const thickness = 1.5 + (edgeWidth - 1.5) * distance ** 1.18 * state.exploreProgress;
    const half = thickness / 2;
    left.push({ x: point.x + normalX * half, y: point.y + normalY * half });
    right.push({ x: point.x - normalX * half, y: point.y - normalY * half });
  });
  const boundary = [...left, ...right.reverse()];
  railShape.setAttribute("d", `${boundary.map((point, index) => `${index ? "L" : "M"} ${point.x} ${point.y}`).join(" ")} Z`);
}

function railXAtY(y, fallback) {
  try {
    const length = railPath.getTotalLength();
    let low = 0;
    let high = length;
    for (let index = 0; index < 14; index += 1) {
      const middle = (low + high) / 2;
      if (railPath.getPointAtLength(middle).y < y) low = middle;
      else high = middle;
    }
    return railPath.getPointAtLength((low + high) / 2).x;
  } catch {
    return fallback;
  }
}

function renderGeometry() {
  if (!state.articles.length) return;
  if (state.mobile) {
    const height = Math.max(420, state.articles.length * 74 + 90);
    rail.setAttribute("viewBox", `0 0 ${stage.clientWidth || window.innerWidth} ${height}`);
    railGradient.setAttribute("y2", String(height));
    railGradient.setAttribute("y1", "0");
    for (const stop of railEdgeStops) stop.setAttribute("stop-opacity", "0");
    railPath.style.opacity = "1";
    railShape.style.display = "none";
    railPath.setAttribute("d", `M ${Math.max(24, (stage.clientWidth || window.innerWidth) * 0.07)} 0 L ${Math.max(24, (stage.clientWidth || window.innerWidth) * 0.07)} ${height}`);
    list.querySelectorAll(".journal-item").forEach((item, itemIndex) => {
      item.style.removeProperty("transform");
      item.style.opacity = String(Math.max(0.18, 1 - itemIndex * 0.12));
      item.style.zIndex = String(state.articles.length - itemIndex);
    });
    return;
  }
  const values = geometry();
  rail.setAttribute("viewBox", `0 0 ${values.width} ${values.height}`);
  railGradient.setAttribute("y2", String(values.height));
  const freshTop = values.height * 0.33;
  const top = freshTop + (70 - freshTop) * state.exploreProgress;
  const bottom = (values.height - 52) + ((values.height - 70) - (values.height - 52)) * state.exploreProgress;
  const focusX = values.baseX - values.bend;
  const topX = values.baseX + values.bend * state.lens.upperEdgeDrift;
  const bottomX = values.baseX + values.bend * state.lens.lowerEdgeDrift;
  railPath.setAttribute("d", [
    `M ${topX} ${top}`,
    `C ${topX} ${top + (values.focusY - top) * state.lens.upperLead}, ${focusX + values.bend * state.lens.waistDrift} ${values.focusY - state.lens.upperShoulder}, ${focusX} ${values.focusY}`,
    `C ${focusX - values.bend * state.lens.waistDrift} ${values.focusY + state.lens.lowerShoulder}, ${bottomX} ${bottom - (bottom - values.focusY) * state.lens.lowerLead}, ${bottomX} ${bottom}`,
  ].join(" "));
  renderRailShape(values, top, bottom);
  const rowGap = Math.max(42, Math.min(64, values.height * 0.065));
  const labelGap = Math.max(40, Math.min(54, values.width * 0.035));
  list.querySelectorAll(".journal-item").forEach((item, itemIndex) => {
    const offset = itemIndex - state.position;
    const y = values.focusY + offset * rowGap;
    const x = railXAtY(y, curveX(y, values)) + labelGap;
    const distance = Math.abs(y - values.focusY);
    const fade = Math.max(0, 1 - distance / (values.height * 0.51));
    const selected = itemIndex === state.selectedIndex;
    const expandedOpacity = selected ? 1 : Math.max(0.04, fade ** 1.45);
    const opacity = expandedOpacity * state.exploreProgress + (selected ? 1 : 0) * (1 - state.exploreProgress);
    item.style.transform = `translate3d(${x}px, ${y}px, 0) translateY(-50%) scale(${selected ? 1.08 : 1})`;
    item.style.opacity = String(opacity);
    item.style.pointerEvents = opacity > 0.18 ? "auto" : "none";
    item.style.zIndex = String(1000 - Math.round(distance));
  });
}

function setExplore(next) {
  if (state.mobile) return;
  if (next && !state.exploreTarget) state.lens = randomLens();
  state.exploreTarget = next ? 1 : 0;
  shell.classList.toggle("is-exploring", next);
  if (next && !state.hasInteracted) {
    state.hasInteracted = true;
    shell.classList.add("has-interacted");
    commitSelection(true);
  }
}

function updatePointerVelocity() {
  if (state.mobile || state.pointerX >= window.innerWidth / 2 || !state.exploreTarget || document.activeElement === search) {
    state.mouseVelocity = 0;
    return;
  }
  const height = window.innerHeight;
  if (state.pointerY < height / 3) {
    const ratio = Math.max(0, (height / 3 - state.pointerY) / (height / 3));
    state.mouseVelocity = -(0.15 + 2.55 * ratio ** 2);
  } else if (state.pointerY > height * 0.75) {
    const ratio = Math.max(0, (state.pointerY - height * 0.75) / (height * 0.25));
    state.mouseVelocity = 0.15 + 2.55 * ratio ** 2;
  } else state.mouseVelocity = 0;
}

function animationFrame(now) {
  const seconds = Math.min(0.05, (now - state.lastFrame) / 1000);
  state.lastFrame = now;
  const difference = state.exploreTarget - state.exploreProgress;
  if (Math.abs(difference) > 0.001) {
    state.exploreProgress += difference * Math.min(1, seconds * 7.5);
  } else state.exploreProgress = state.exploreTarget;
  updatePointerVelocity();
  if (state.articles.length) {
    const moving = Math.abs(state.wheelVelocity) > 0.002 || Math.abs(state.mouseVelocity) > 0.002;
    if (moving) {
      state.position = Math.max(0, Math.min(state.articles.length - 1, state.position + (state.wheelVelocity + state.mouseVelocity) * seconds));
      state.wheelVelocity *= Math.pow(0.045, seconds);
      commitSelection(true);
    } else if (now - state.wheelAt > 130) {
      const target = Math.round(state.position);
      state.position += (target - state.position) * Math.min(1, seconds * 10);
      if (Math.abs(target - state.position) < 0.002) state.position = target;
    }
  }
  renderGeometry();
  requestAnimationFrame(animationFrame);
}

function bindDesktopInteraction() {
  window.addEventListener("pointermove", (event) => {
    state.pointerX = event.clientX;
    state.pointerY = event.clientY;
    if (state.mobile) return;
    const overControls = event.target.closest(".journal-controls");
    if (!overControls && event.clientX < window.innerWidth * 0.46 && event.clientY > window.innerHeight * 0.2) setExplore(true);
    else if (event.clientX > window.innerWidth / 2) setExplore(false);
  }, { passive: true });
  window.addEventListener("wheel", (event) => {
    if (state.mobile || event.clientX >= window.innerWidth / 2 || event.target.closest(".journal-controls")) return;
    event.preventDefault();
    setExplore(true);
    state.wheelVelocity += Math.max(-14, Math.min(14, event.deltaY * 0.055));
    state.wheelAt = performance.now();
  }, { passive: false });
  window.addEventListener("keydown", (event) => {
    if (state.mobile || !state.articles.length || document.activeElement === search) return;
    if (["ArrowDown", "PageDown"].includes(event.key)) {
      event.preventDefault();
      setExplore(true);
      state.position = Math.min(state.articles.length - 1, Math.round(state.position) + 1);
      commitSelection(true);
    }
    if (["ArrowUp", "PageUp"].includes(event.key)) {
      event.preventDefault();
      setExplore(true);
      state.position = Math.max(0, Math.round(state.position) - 1);
      commitSelection(true);
    }
    if (event.key === "Enter" && selectedArticle()) openArticle(selectedArticle());
  });
}

function bindControls() {
  search.addEventListener("input", () => {
    state.query = search.value;
    buildList();
  });
  sortButton.addEventListener("click", () => {
    state.sort = state.sort === "newest" ? "oldest" : "newest";
    sortButton.textContent = state.sort === "newest" ? "Newest first" : "Oldest first";
    buildList();
  });
  window.addEventListener("resize", () => {
    const mobile = matchMedia("(max-width: 760px), (pointer: coarse)").matches;
    if (mobile !== state.mobile) {
      state.mobile = mobile;
      state.exploreProgress = mobile ? 0 : state.exploreProgress;
      state.exploreTarget = 0;
      shell.classList.remove("is-exploring");
      buildList();
    } else renderGeometry();
  });
}

async function initialize() {
  const [content, articleResponse] = await Promise.all([api("/api/content"), api("/api/articles?sort=newest")]);
  const title = content.pages.journal.title;
  applySiteChrome(content, title);
  bindThemeControls();
  document.querySelector("[data-journal-title]").textContent = title;
  state.all = articleResponse.items;
  buildList();
  bindControls();
  bindDesktopInteraction();
  playPageTransition();
  pageReady();
  requestAnimationFrame(animationFrame);
}

initialize().catch((error) => {
  empty.hidden = false;
  empty.textContent = error.message;
  pageReady();
});
