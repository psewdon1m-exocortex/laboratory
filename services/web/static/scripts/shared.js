let activeClock = null;

export async function api(path, options = {}) {
  const response = await fetch(path, {
    credentials: "same-origin",
    ...options,
    headers: {
      ...(options.body instanceof FormData ? {} : options.body ? { "Content-Type": "application/json" } : {}),
      ...(options.headers || {}),
    },
  });
  const type = response.headers.get("content-type") || "";
  const value = type.includes("application/json") ? await response.json() : await response.text();
  if (!response.ok) throw new Error(value?.error || value || `Request failed with HTTP ${response.status}`);
  return value;
}

export function applyThemeDefault(content) {
  let hasSaved = false;
  try { hasSaved = ["dark", "light"].includes(localStorage.getItem("laboratory_theme")); } catch {}
  if (!hasSaved && ["dark", "light"].includes(content?.settings?.themeDefault)) {
    setTheme(content.settings.themeDefault, false);
  }
}

export function setTheme(mode, persist = true) {
  const resolved = mode === "system"
    ? (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light")
    : mode;
  document.documentElement.dataset.theme = resolved;
  document.documentElement.dataset.themeMode = mode;
  if (persist) {
    try {
      if (mode === "system") localStorage.removeItem("laboratory_theme");
      else localStorage.setItem("laboratory_theme", mode);
    } catch {}
  }
  updateThemeButtons();
  window.dispatchEvent(new CustomEvent("laboratory-theme-change", { detail: { mode, resolved } }));
}

function updateThemeButtons() {
  const current = document.documentElement.dataset.theme || "dark";
  document.querySelectorAll("[data-theme-toggle]").forEach((button) => {
    button.textContent = current === "dark" ? "Light" : "Dark";
    button.setAttribute("aria-label", `Use ${current === "dark" ? "light" : "dark"} theme`);
  });
}

export function bindThemeControls() {
  updateThemeButtons();
  document.querySelectorAll("[data-theme-toggle]").forEach((button) => {
    button.addEventListener("click", () => {
      setTheme(document.documentElement.dataset.theme === "dark" ? "light" : "dark");
    });
  });
  matchMedia("(prefers-color-scheme: dark)").addEventListener("change", (event) => {
    if (document.documentElement.dataset.themeMode === "system") setTheme(event.matches ? "dark" : "light", false);
  });
}

export function startClock(element, timeZone = "UTC") {
  if (!element) return;
  if (activeClock) clearInterval(activeClock);
  let formatter;
  try {
    formatter = new Intl.DateTimeFormat("en-GB", {
      timeZone,
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false,
    });
  } catch {
    formatter = new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });
  }
  const place = String(timeZone).split("/").pop().replaceAll("_", " ").toUpperCase();
  const render = () => { element.textContent = `${formatter.format(new Date())} ${place} TIME`; };
  render();
  activeClock = setInterval(render, 1000);
}

export function applySiteChrome(content, pageTitle = "") {
  applyThemeDefault(content);
  document.querySelectorAll("[data-site-title]").forEach((element) => { element.textContent = content.siteTitle; });
  document.querySelectorAll("[data-page-title]").forEach((element) => { element.textContent = pageTitle; });
  startClock(document.querySelector("[data-clock]"), content.settings?.timeZone);
  if (pageTitle) document.title = `${pageTitle} — ${content.siteTitle}`;
  else document.title = content.siteTitle;
}

export function applyNoise(element, noise) {
  if (!element) return;
  element.classList.toggle("enabled", Boolean(noise?.enabled));
  window.__noiseConfig = { intensity: noise?.intensity ?? 32, grain: noise?.grain ?? 55 };
  window.dispatchEvent(new CustomEvent("noise-config-change", { detail: window.__noiseConfig }));
}

export function formatDate(value) {
  return new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "long", year: "numeric" }).format(new Date(value));
}

export function formatPublicationDate(publishedAt, revisedAt) {
  if (!publishedAt) return "Not published";
  const published = formatDate(publishedAt);
  return revisedAt ? `${published} · revised ${formatDate(revisedAt)}` : published;
}

const TRANSITION_KEY = "laboratory_navigation_transition";

export function preparePageTransition(link) {
  const rect = link.getBoundingClientRect();
  const clone = link.cloneNode(true);
  clone.classList.add("transition-clone");
  Object.assign(clone.style, {
    top: `${rect.top}px`, left: `${rect.left}px`, width: `${rect.width}px`, height: `${rect.height}px`,
    backgroundImage: getComputedStyle(link).backgroundImage,
    backgroundSize: "cover", backgroundPosition: "center",
  });
  clone.querySelectorAll("span").forEach((text) => { text.style.opacity = "1"; });
  document.body.appendChild(clone);
  requestAnimationFrame(() => requestAnimationFrame(() => {
    Object.assign(clone.style, { top: "0", left: "0", width: "100vw", height: "100vh" });
    clone.querySelectorAll("span").forEach((text) => { text.style.opacity = "0"; });
  }));
  try {
    sessionStorage.setItem(TRANSITION_KEY, JSON.stringify({ ts: Date.now(), backgroundImage: getComputedStyle(link).backgroundImage }));
  } catch {}
  return new Promise((resolve) => setTimeout(resolve, 1450));
}

export function playPageTransition() {
  const overlay = document.querySelector("[data-transition-overlay]");
  if (!overlay) return;
  try {
    const value = JSON.parse(sessionStorage.getItem(TRANSITION_KEY) || "null");
    sessionStorage.removeItem(TRANSITION_KEY);
    if (!value?.ts || Date.now() - value.ts > 12000) return;
    overlay.style.backgroundImage = value.backgroundImage || "";
    overlay.classList.add("is-visible");
    requestAnimationFrame(() => requestAnimationFrame(() => overlay.classList.add("fade-out")));
    setTimeout(() => overlay.remove(), 1300);
  } catch {}
}

export function pageReady() {
  document.body.classList.remove("page-loading");
  document.body.classList.add("page-ready");
}
