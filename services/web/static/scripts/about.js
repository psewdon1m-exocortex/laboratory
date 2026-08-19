import {
  api,
  applyNoise,
  applySiteChrome,
  bindThemeControls,
  pageReady,
  playPageTransition,
} from "./shared.js";

async function initialize() {
  const pageDataElement = document.getElementById("page-data");
  const pageData = pageDataElement ? JSON.parse(pageDataElement.textContent) : null;
  const [content, about] = pageData
    ? [pageData.content, pageData.about]
    : await Promise.all([api("/api/content"), api("/api/about")]);
  const title = content.pages.about.title;
  applySiteChrome(content, title);
  bindThemeControls();
  applyNoise(document.getElementById("aboutNoise"), content.settings.noise);
  document.querySelector("[data-about-title]").textContent = title;
  const root = document.querySelector("[data-about-document]");
  const placeholder = document.querySelector("[data-about-placeholder]");
  if (about.bodyHtml) {
    root.innerHTML = about.bodyHtml;
  } else {
    root.hidden = true;
    placeholder.hidden = false;
  }
  playPageTransition();
  pageReady();
}

initialize().catch((error) => {
  console.error(error);
  const placeholder = document.querySelector("[data-about-placeholder]");
  placeholder.querySelector("p").textContent = error.message;
  placeholder.hidden = false;
  pageReady();
});
