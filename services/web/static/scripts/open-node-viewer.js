const instances = new Set();
let viewerModulePromise = null;

function viewerModule() {
  if (!viewerModulePromise) viewerModulePromise = import("/vendor/open-node-viewer.js");
  return viewerModulePromise;
}

function applyTheme(container) {
  const dark = document.documentElement.dataset.theme === "dark";
  const values = dark
    ? { bg: "#111111", panel: "#181818", "panel-2": "#202020", "panel-3": "#292929", text: "#f4f2ed", muted: "#9f9c96", border: "#3d3b38", "border-strong": "#5c5954", accent: "#f4f2ed", "accent-2": "#d6d2ca" }
    : { bg: "#f4f2ed", panel: "#ffffff", "panel-2": "#f3f1ec", "panel-3": "#e8e4dc", text: "#111111", muted: "#77736c", border: "#c8c4bc", "border-strong": "#979188", accent: "#111111", "accent-2": "#494640" };
  const root = container.querySelector(".on-editor");
  if (!root) return;
  root.dataset.theme = dark ? "dark" : "light";
  for (const [key, value] of Object.entries(values)) root.style.setProperty(`--on-${key}`, value);
}

async function mount(container) {
  if (container.dataset.workflowState) return;
  container.dataset.workflowState = "loading";
  try {
    const [project, module] = await Promise.all([
      fetch(container.dataset.workflowSrc, { credentials: "same-origin" }).then(async (response) => {
        if (!response.ok) throw new Error(`Canvas returned HTTP ${response.status}`);
        return response.json();
      }),
      viewerModule(),
    ]);
    container.replaceChildren();
    const instance = module.mountOpenNode(container, project, document.documentElement.dataset.theme === "dark" ? "dark" : "light");
    instances.add({ container, instance });
    container.dataset.workflowState = "ready";
    requestAnimationFrame(() => requestAnimationFrame(() => instance.viewport.fitAll()));
  } catch (error) {
    container.dataset.workflowState = "error";
    const message = document.createElement("p");
    message.className = "article-workflow-status";
    message.textContent = error.message;
    container.replaceChildren(message);
  }
}

export function initializeWorkflowViewers(root = document) {
  const canvases = [...root.querySelectorAll("[data-workflow-src]")];
  if (!canvases.length) return;
  const observer = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      observer.unobserve(entry.target);
      mount(entry.target);
    }
  }, { rootMargin: "650px 0px" });
  for (const canvas of canvases) observer.observe(canvas);
}

window.addEventListener("laboratory-theme-change", () => {
  for (const entry of instances) applyTheme(entry.container);
});
