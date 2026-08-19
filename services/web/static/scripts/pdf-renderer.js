const renderStates = new WeakMap();
let pdfModulePromise = null;

async function pdfModule() {
  if (!pdfModulePromise) {
    pdfModulePromise = import("/vendor/pdfjs/pdf.mjs").then((module) => {
      module.GlobalWorkerOptions.workerSrc = "/vendor/pdfjs/pdf.worker.mjs";
      return module;
    });
  }
  return pdfModulePromise;
}

export async function renderPdf(url, root, options = {}) {
  const previous = renderStates.get(root);
  if (previous) {
    previous.cancelled = true;
    previous.observer?.disconnect();
    if (typeof previous.task?.destroy === "function") previous.task.destroy();
    else if (typeof previous.document?.destroy === "function") previous.document.destroy();
  }
  const state = { cancelled: false, observer: null, document: null, task: null };
  renderStates.set(root, state);
  root.innerHTML = '<p class="pdf-loading">Loading document</p>';
  const { getDocument } = await pdfModule();
  const task = getDocument({ url, withCredentials: true });
  state.task = task;
  const pdf = await task.promise;
  state.document = pdf;
  if (state.cancelled) {
    if (typeof task.destroy === "function") await task.destroy();
    return;
  }
  root.innerHTML = "";
  const targetWidth = Math.max(240, Math.floor(options.width ?? root.clientWidth ?? window.innerWidth));
  const pages = [];
  for (let number = 1; number <= pdf.numPages; number += 1) {
    const page = await pdf.getPage(number);
    if (state.cancelled) return;
    const viewport = page.getViewport({ scale: 1 });
    const logicalScale = targetWidth / viewport.width;
    const logicalHeight = Math.round(viewport.height * logicalScale);
    const wrapper = document.createElement("div");
    wrapper.className = "pdf-render-page";
    wrapper.style.aspectRatio = `${viewport.width} / ${viewport.height}`;
    wrapper.dataset.page = String(number);
    root.appendChild(wrapper);
    pages.push({ page, wrapper, logicalScale, logicalHeight, rendered: false });
  }

  const renderPage = async (item) => {
    if (item.rendered || state.cancelled) return;
    item.rendered = true;
    const dpr = Math.min(window.devicePixelRatio || 1, options.preview ? 1.25 : 1.8);
    const viewport = item.page.getViewport({ scale: item.logicalScale * dpr });
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.floor(viewport.width));
    canvas.height = Math.max(1, Math.floor(viewport.height));
    canvas.style.width = `${targetWidth}px`;
    canvas.style.height = `${item.logicalHeight}px`;
    item.wrapper.appendChild(canvas);
    await item.page.render({ canvasContext: canvas.getContext("2d", { alpha: false }), viewport }).promise;
    item.wrapper.classList.add("is-rendered");
  };

  state.observer = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      if (entry.isIntersecting) {
        const item = pages.find((candidate) => candidate.wrapper === entry.target);
        if (item) renderPage(item).catch(() => { item.rendered = false; });
      }
    }
  }, { root: options.scrollRoot ?? null, rootMargin: options.preview ? "180px" : "600px" });
  for (const item of pages) state.observer.observe(item.wrapper);
  if (pages[0]) await renderPage(pages[0]);
  return { pages: pdf.numPages };
}

export function clearPdf(root) {
  const state = renderStates.get(root);
  if (state) {
    state.cancelled = true;
    state.observer?.disconnect();
    if (typeof state.task?.destroy === "function") state.task.destroy();
    else if (typeof state.document?.destroy === "function") state.document.destroy();
    renderStates.delete(root);
  }
  root.innerHTML = "";
}
