import {
  api,
  applyNoise,
  applySiteChrome,
  bindThemeControls,
  pageReady,
  preparePageTransition,
} from "./shared.js";

const hero = document.getElementById("hero");
const aboutLink = document.getElementById("aboutLink");
const journalLink = document.getElementById("journalLink");
let animationLock = false;
let touchStartY = null;
let animationFrame = null;

function applyCurtain() {
  const maximum = window.innerHeight;
  const position = Math.min(Math.max(window.scrollY, 0), maximum);
  hero.style.transform = `translateY(-${position}px)`;
  hero.style.pointerEvents = position >= maximum - 2 ? "none" : "auto";
}

function smoothScrollTo(targetY) {
  if (animationFrame) cancelAnimationFrame(animationFrame);
  animationLock = true;
  const startY = window.scrollY;
  const delta = targetY - startY;
  const startedAt = performance.now();
  const duration = 1450;
  const tick = (now) => {
    const progress = Math.min((now - startedAt) / duration, 1);
    const eased = progress < 0.5 ? 4 * progress ** 3 : 1 - ((-2 * progress + 2) ** 3) / 2;
    window.scrollTo(0, startY + delta * eased);
    applyCurtain();
    if (progress < 1) animationFrame = requestAnimationFrame(tick);
    else { animationFrame = null; animationLock = false; }
  };
  animationFrame = requestAnimationFrame(tick);
}

function moveCurtain(direction) {
  if (animationLock) return;
  const closed = window.scrollY >= window.innerHeight / 2;
  if (direction > 0 && !closed) smoothScrollTo(window.innerHeight);
  else if (direction < 0 && closed) smoothScrollTo(0);
}

function bindCurtain() {
  hero.addEventListener("click", () => moveCurtain(1));
  window.addEventListener("wheel", (event) => {
    if (Math.abs(event.deltaY) < 8) return;
    event.preventDefault();
    moveCurtain(event.deltaY > 0 ? 1 : -1);
  }, { passive: false });
  window.addEventListener("keydown", (event) => {
    if (["ArrowDown", "PageDown", " "].includes(event.key)) { event.preventDefault(); moveCurtain(1); }
    if (["ArrowUp", "PageUp"].includes(event.key)) { event.preventDefault(); moveCurtain(-1); }
  });
  window.addEventListener("touchstart", (event) => { touchStartY = event.touches[0]?.clientY ?? null; }, { passive: true });
  window.addEventListener("touchend", (event) => {
    if (touchStartY == null) return;
    const delta = touchStartY - (event.changedTouches[0]?.clientY ?? touchStartY);
    if (Math.abs(delta) > 20) moveCurtain(delta > 0 ? 1 : -1);
    touchStartY = null;
  }, { passive: true });
  window.addEventListener("scroll", applyCurtain, { passive: true });
  window.addEventListener("resize", applyCurtain);
  applyCurtain();
}

function bindNavigation() {
  [aboutLink, journalLink].forEach((link) => link.addEventListener("click", async (event) => {
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    if (animationLock) return;
    animationLock = true;
    const destination = link.href;
    await Promise.all([
      preparePageTransition(link),
      fetch(destination, { cache: "force-cache" }).catch(() => null),
    ]);
    window.location.href = destination;
  }));
}

function restoreHomeAfterHistoryNavigation() {
  if (animationFrame) cancelAnimationFrame(animationFrame);
  animationFrame = null;
  animationLock = false;
  document.querySelectorAll(".transition-clone").forEach((clone) => clone.remove());
  window.scrollTo(0, 0);
  hero.style.transform = "translateY(0)";
  hero.style.pointerEvents = "auto";
  requestAnimationFrame(() => {
    window.scrollTo(0, 0);
    applyCurtain();
  });
}

window.addEventListener("pageshow", (event) => {
  const navigation = performance.getEntriesByType("navigation")[0];
  if (event.persisted || navigation?.type === "back_forward") restoreHomeAfterHistoryNavigation();
});

async function initialize() {
  if ("scrollRestoration" in history) history.scrollRestoration = "manual";
  window.scrollTo(0, 0);
  const content = await api("/api/content");
  applySiteChrome(content);
  bindThemeControls();
  document.getElementById("heroTitle").textContent = content.heroTitle;
  document.getElementById("heroSubtitle").textContent = content.heroSubtitle;
  document.getElementById("aboutLabel").textContent = content.pages.about.title;
  document.getElementById("journalLabel").textContent = content.pages.journal.title;
  const assets = content.publicAssets || {};
  if (assets.heroImage) hero.style.backgroundImage = `url("${assets.heroImage}")`;
  aboutLink.style.backgroundImage = assets.aboutImage ? `url("${assets.aboutImage}")` : "radial-gradient(circle at 30% 20%, #5d280f, #221511 70%)";
  journalLink.style.backgroundImage = assets.journalImage ? `url("${assets.journalImage}")` : "radial-gradient(circle at 60% 20%, #43413b, #1d1d1d 70%)";
  applyNoise(document.getElementById("heroNoise"), content.settings.noise);
  bindCurtain();
  bindNavigation();
  pageReady();
}

initialize().catch((error) => console.error(error));
