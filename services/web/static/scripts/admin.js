import { api, bindThemeControls, formatPublicationDate } from "./shared.js";

const loginCard = document.querySelector("[data-login-card]");
const loginForm = document.querySelector("[data-login-form]");
const protectedRoot = document.querySelector("[data-admin-protected]");
const contentForm = document.querySelector("[data-content-form]");
const uploadGrid = document.querySelector("[data-upload-grid]");
const articlesRoot = document.querySelector("[data-admin-articles]");
const runtimeRoot = document.querySelector("[data-runtime]");
const neptuneRuntime = document.querySelector("[data-neptune-runtime]");
const neptuneEnabled = document.querySelector("[data-neptune-enabled]");
const neptuneInterval = document.querySelector("[data-neptune-interval]");
const neptuneResult = document.querySelector("[data-neptune-result]");
const neptuneInstall = document.querySelector("[data-neptune-install]");
const toast = document.querySelector("[data-toast]");
const importForm = document.querySelector("[data-article-import-form]");
const editor = document.querySelector("[data-article-editor]");
const editorForm = document.querySelector("[data-article-editor-form]");
const articleFiles = document.querySelector("[data-article-files]");
const articleRevisions = document.querySelector("[data-article-revisions]");
const editorCollapse = document.querySelector("[data-editor-collapse]");
const editorDelete = document.querySelector("[data-editor-delete]");
const confirmDialog = document.querySelector("[data-confirm-dialog]");
const confirmTitle = document.querySelector("[data-confirm-title]");
const confirmMessage = document.querySelector("[data-confirm-message]");
const confirmAccept = document.querySelector("[data-confirm-accept]");
const confirmCancel = document.querySelector("[data-confirm-cancel]");
let csrfToken = "";
let currentState = null;
let selectedArticleId = "";
let confirmResolver = null;
let neptuneStatus = null;
let neptuneRelease = null;

const uploads = [
  { slot: "heroImage", label: "Hero image", accept: "image/png,image/jpeg,image/webp,image/avif,image/gif" },
  { slot: "aboutImage", label: "About Me choice image", accept: "image/png,image/jpeg,image/webp,image/avif,image/gif" },
  { slot: "journalImage", label: "Journal choice image", accept: "image/png,image/jpeg,image/webp,image/avif,image/gif" },
  { slot: "aboutMarkdown", label: "About Me Markdown", accept: "text/markdown,.md" },
];

function showToast(message) {
  toast.textContent = message;
  toast.hidden = false;
  clearTimeout(showToast.timer);
  showToast.timer = setTimeout(() => { toast.hidden = true; }, 3000);
}

function finishConfirmation(accepted) {
  const resolve = confirmResolver;
  confirmResolver = null;
  if (confirmDialog.open) confirmDialog.close();
  resolve?.(accepted);
}

function confirmAction({ title, message, confirmLabel = "Confirm", danger = false }) {
  if (confirmResolver) finishConfirmation(false);
  confirmTitle.textContent = title;
  confirmMessage.textContent = message;
  confirmAccept.textContent = confirmLabel;
  confirmAccept.classList.toggle("button-danger", danger);
  return new Promise((resolve) => {
    confirmResolver = resolve;
    confirmDialog.showModal();
    requestAnimationFrame(() => confirmCancel.focus());
  });
}

confirmAccept.addEventListener("click", () => finishConfirmation(true));
confirmCancel.addEventListener("click", () => finishConfirmation(false));
confirmDialog.addEventListener("cancel", (event) => {
  event.preventDefault();
  finishConfirmation(false);
});
confirmDialog.addEventListener("click", (event) => {
  if (event.target === confirmDialog) finishConfirmation(false);
});

function mutation(path, options = {}) {
  return api(path, { ...options, headers: { "X-CSRF-Token": csrfToken, ...(options.headers || {}) } });
}

function setAuthenticated(authenticated) {
  loginCard.hidden = authenticated;
  protectedRoot.hidden = !authenticated;
}

function fillContent(content) {
  contentForm.siteTitle.value = content.siteTitle || "";
  contentForm.heroTitle.value = content.heroTitle || "";
  contentForm.heroSubtitle.value = content.heroSubtitle || "";
  contentForm.aboutTitle.value = content.pages?.about?.title || "";
  contentForm.journalTitle.value = content.pages?.journal?.title || "";
  contentForm.timeZone.value = content.settings?.timeZone || "UTC";
  contentForm.themeDefault.value = content.settings?.themeDefault || "system";
  contentForm.noiseEnabled.checked = Boolean(content.settings?.noise?.enabled);
  contentForm.noiseIntensity.value = String(content.settings?.noise?.intensity ?? 32);
  contentForm.noiseGrain.value = String(content.settings?.noise?.grain ?? 55);
}

function renderUploads(content) {
  uploadGrid.replaceChildren();
  for (const definition of uploads) {
    const item = document.createElement("div");
    item.className = "upload-item";
    const current = content.publicAssets?.[definition.slot];
    item.innerHTML = `
      <strong>${definition.label}</strong>
      <span class="upload-status">${current ? "Uploaded" : "Not uploaded"}</span>
      <label class="button-file">Choose file<input type="file" accept="${definition.accept}" /></label>
      <button class="button-quiet" type="button" ${current ? "" : "disabled"}>Remove</button>
    `;
    const input = item.querySelector("input");
    input.addEventListener("change", async () => {
      if (!input.files?.[0]) return;
      const data = new FormData();
      data.append("file", input.files[0]);
      try {
        const next = await mutation(`/api/admin/upload/${definition.slot}`, { method: "POST", body: data });
        currentState.content = next;
        fillContent(next);
        renderUploads(next);
        showToast(`${definition.label} uploaded`);
      } catch (error) { showToast(error.message); }
    });
    item.querySelector("button").addEventListener("click", async () => {
      try {
        const next = await mutation(`/api/admin/upload/${definition.slot}`, { method: "DELETE" });
        currentState.content = next;
        renderUploads(next);
        showToast(`${definition.label} removed`);
      } catch (error) { showToast(error.message); }
    });
    uploadGrid.appendChild(item);
  }
}

function renderArticles(articles) {
  articlesRoot.replaceChildren();
  for (const article of articles) {
    const row = document.createElement("button");
    row.type = "button";
    row.className = "admin-article-row";
    const name = document.createElement("span");
    name.textContent = `${article.title} — ${article.internalId}`;
    const date = document.createElement("time");
    date.textContent = formatPublicationDate(article.publishedAt, article.revisedAt);
    const status = document.createElement("small");
    status.textContent = `${article.status} · r${article.revision} · ${article.format}`;
    row.append(name, date, status);
    row.setAttribute("aria-expanded", String(selectedArticleId === article.internalId && !editor.hidden));
    row.addEventListener("click", () => {
      if (selectedArticleId === article.internalId && !editor.hidden) closeArticleEditor();
      else openArticleEditor(article.internalId);
    });
    articlesRoot.appendChild(row);
  }
}

function closeArticleEditor() {
  selectedArticleId = "";
  editor.hidden = true;
  for (const row of articlesRoot.querySelectorAll("[aria-expanded='true']")) row.setAttribute("aria-expanded", "false");
}

function fileSize(value) {
  const bytes = Number(value) || 0;
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function renderArticleEditor(article) {
  selectedArticleId = article.internalId;
  editor.hidden = false;
  document.querySelector("[data-editor-id]").textContent = `${article.internalId} · revision ${article.revision}`;
  document.querySelector("[data-editor-heading]").textContent = article.title;
  document.querySelector("[data-editor-download]").href = `/api/admin/articles/${encodeURIComponent(article.internalId)}/archive`;
  editorForm.title.value = article.title;
  editorForm.slug.value = article.slug;
  editorForm.status.value = article.status;
  editorForm.markdownSource.value = article.markdownSource || "";
  document.querySelector("[data-markdown-field]").hidden = article.format !== "markdown";
  articleFiles.replaceChildren();
  for (const file of article.files || []) {
    const row = document.createElement("div");
    row.className = "article-file-row";
    const label = document.createElement("span");
    label.textContent = file.path;
    const meta = document.createElement("small");
    meta.textContent = `${file.kind} · ${fileSize(file.size)}`;
    row.append(label, meta);
    if (file.kind !== "main") {
      const remove = document.createElement("button");
      remove.type = "button";
      remove.className = "button-quiet";
      remove.textContent = "Remove";
      remove.addEventListener("click", () => removeArticleFile(file.path));
      row.appendChild(remove);
    }
    articleFiles.appendChild(row);
  }
  articleRevisions.replaceChildren();
  const heading = document.createElement("h4");
  heading.textContent = "Revision history";
  articleRevisions.appendChild(heading);
  for (const revision of article.revisions || []) {
    const row = document.createElement("p");
    row.textContent = `r${revision.revision} · ${revision.state} · ${revision.sourceKind} · ${formatPublicationDate(revision.createdAt, null)}`;
    articleRevisions.appendChild(row);
  }
}

async function openArticleEditor(id) {
  try {
    renderArticleEditor(await api(`/api/admin/articles/${encodeURIComponent(id)}`));
    editor.scrollIntoView({ behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth", block: "start" });
  } catch (error) { showToast(error.message); }
}

function writebackMessage(result, fallback) {
  if (result.writeback?.written) return `${fallback}; committed to ${result.writeback.path}`;
  if (result.writeback?.error) return `${fallback}; GitHub writeback pending: ${result.writeback.error}`;
  return `${fallback}; stored locally`;
}

async function refreshAfterArticleChange(result, message) {
  selectedArticleId = result.article.internalId;
  await loadState();
  await openArticleEditor(selectedArticleId);
  showToast(writebackMessage(result, message));
}

async function uploadArticleFile(input, folder) {
  const file = input.files?.[0];
  if (!file || !selectedArticleId) return;
  const body = new FormData();
  body.append("file", file);
  try {
    const result = await mutation(`/api/admin/articles/${encodeURIComponent(selectedArticleId)}/files/${folder}`, { method: "POST", body });
    await refreshAfterArticleChange(result, `${file.name} added`);
  } catch (error) { showToast(error.message); }
  input.value = "";
}

async function removeArticleFile(filePath) {
  if (!selectedArticleId) return;
  const accepted = await confirmAction({
    title: "Remove article file?",
    message: `${filePath} will be removed from the next revision. Earlier revisions remain unchanged.`,
    confirmLabel: "Remove file",
    danger: true,
  });
  if (!accepted) return;
  try {
    const result = await mutation(`/api/admin/articles/${encodeURIComponent(selectedArticleId)}/files?path=${encodeURIComponent(filePath)}`, { method: "DELETE" });
    await refreshAfterArticleChange(result, `${filePath} removed`);
  } catch (error) { showToast(error.message); }
}

function runtimeItem(name, value) {
  const term = document.createElement("dt");
  term.textContent = name;
  const description = document.createElement("dd");
  description.textContent = value || "Not configured";
  runtimeRoot.append(term, description);
}

function renderRuntime(runtime) {
  runtimeRoot.replaceChildren();
  runtimeItem("Version", runtime.version);
  runtimeItem("Kernel revision", runtime.registerRevision || runtime.registerError || "Local mode");
  runtimeItem("Repository", runtime.repositoryUrl);
  runtimeItem("Article repository", runtime.contentLibrary?.repositoryUrl);
  runtimeItem("Article branch", runtime.contentLibrary?.branch);
  runtimeItem("Last article sync", runtime.contentLibrary?.lastSyncAt || runtime.contentLibrary?.lastError);
  runtimeItem("Public URL", runtime.publicUrl);
  runtimeItem("Updater", runtime.updater?.available ? `${runtime.updater.status} / ${runtime.updater.version}` : "Not installed locally");
}

function renderNeptune(status) {
  neptuneRuntime.replaceChildren();
  runtimeItemInto(neptuneRuntime, "Client", status.client_instance_id);
  runtimeItemInto(neptuneRuntime, "Version", `${status.product} ${status.version}`);
  runtimeItemInto(neptuneRuntime, "State", status.active ? "Backup active" : (status.latest_run_state || "Ready"));
  runtimeItemInto(neptuneRuntime, "Last success", status.last_success_at || "Never");
  runtimeItemInto(neptuneRuntime, "Next run", status.project.next_run_at || "Not scheduled");
  neptuneEnabled.checked = status.project.enabled;
  neptuneInterval.value = String(status.project.interval_hours);
  neptuneResult.textContent = status.latest_error || "";
}

function runtimeItemInto(root, name, value) {
  const term = document.createElement("dt");
  term.textContent = name;
  const description = document.createElement("dd");
  description.textContent = value || "Not configured";
  root.append(term, description);
}

async function loadNeptune() {
  try {
    neptuneStatus = await api("/api/neptune/status");
    renderNeptune(neptuneStatus);
  } catch (error) {
    neptuneStatus = null;
    neptuneRuntime.replaceChildren();
    neptuneResult.textContent = error.message;
  }
}

async function loadState() {
  currentState = await api("/api/admin/state");
  fillContent(currentState.content);
  renderUploads(currentState.content);
  renderArticles(currentState.articles);
  renderRuntime(currentState.runtime);
  await loadNeptune();
  const library = currentState.runtime.contentLibrary || {};
  document.querySelector("[data-library-status]").textContent = library.lastError
    ? `Last sync error: ${library.lastError}`
    : library.lastCommit ? `Synced ${library.lastCommit.slice(0, 12)}` : "Not synced yet";
}

loginForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  try {
    const session = await api("/api/admin/login", {
      method: "POST",
      body: JSON.stringify({ username: loginForm.username.value.trim(), password: loginForm.password.value }),
    });
    csrfToken = session.csrfToken;
    document.querySelector("[data-session-label]").textContent = `Signed in as ${session.username}`;
    await loadState();
    setAuthenticated(true);
    loginForm.reset();
  } catch (error) { showToast(error.message); }
});

contentForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const payload = {
    siteTitle: contentForm.siteTitle.value.trim(),
    heroTitle: contentForm.heroTitle.value.trim(),
    heroSubtitle: contentForm.heroSubtitle.value.trim(),
    pages: {
      about: { title: contentForm.aboutTitle.value.trim() },
      journal: { title: contentForm.journalTitle.value.trim() },
    },
    settings: {
      timeZone: contentForm.timeZone.value.trim(),
      themeDefault: contentForm.themeDefault.value,
      noise: {
        enabled: contentForm.noiseEnabled.checked,
        intensity: Number(contentForm.noiseIntensity.value),
        grain: Number(contentForm.noiseGrain.value),
      },
    },
  };
  try {
    const content = await mutation("/api/admin/content", { method: "PUT", body: JSON.stringify(payload) });
    currentState.content = content;
    fillContent(content);
    showToast("Changes saved");
  } catch (error) { showToast(error.message); }
});

importForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const file = importForm.file.files?.[0];
  if (!file) return;
  const body = new FormData();
  body.append("file", file);
  body.append("status", importForm.status.value);
  if (importForm.title.value.trim()) body.append("title", importForm.title.value.trim());
  try {
    const result = await mutation("/api/admin/articles/import", { method: "POST", body });
    importForm.reset();
    await refreshAfterArticleChange(result, "Article archive imported");
  } catch (error) { showToast(error.message); }
});

editorForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!selectedArticleId) return;
  const payload = {
    title: editorForm.title.value.trim(),
    slug: editorForm.slug.value.trim(),
    status: editorForm.status.value,
    ...(document.querySelector("[data-markdown-field]").hidden ? {} : { markdownSource: editorForm.markdownSource.value }),
  };
  try {
    const result = await mutation(`/api/admin/articles/${encodeURIComponent(selectedArticleId)}`, { method: "PUT", body: JSON.stringify(payload) });
    await refreshAfterArticleChange(result, "Article revision saved");
  } catch (error) { showToast(error.message); }
});

document.querySelector("[data-main-file]").addEventListener("change", async (event) => {
  const input = event.currentTarget;
  const file = input.files?.[0];
  if (!file || !selectedArticleId) return;
  const body = new FormData();
  body.append("file", file);
  body.append("title", editorForm.title.value.trim());
  body.append("status", editorForm.status.value);
  body.append("slug", editorForm.slug.value.trim());
  try {
    const result = await mutation(`/api/admin/articles/${encodeURIComponent(selectedArticleId)}/main`, { method: "POST", body });
    await refreshAfterArticleChange(result, "Main article file replaced");
  } catch (error) { showToast(error.message); }
  input.value = "";
});

document.querySelector("[data-article-media]").addEventListener("change", (event) => uploadArticleFile(event.currentTarget, "media"));
document.querySelector("[data-article-attachment]").addEventListener("change", (event) => uploadArticleFile(event.currentTarget, "attachments"));

editorCollapse.addEventListener("click", closeArticleEditor);

editorDelete.addEventListener("click", async () => {
  if (!selectedArticleId) return;
  const title = editorForm.title.value.trim() || selectedArticleId;
  const accepted = await confirmAction({
    title: "Delete article?",
    message: `“${title}” and all of its revisions will be permanently deleted.`,
    confirmLabel: "Delete article",
    danger: true,
  });
  if (!accepted) return;
  try {
    const result = await mutation(`/api/admin/articles/${encodeURIComponent(selectedArticleId)}`, { method: "DELETE" });
    closeArticleEditor();
    await loadState();
    const suffix = result.writeback?.written
      ? "; repository archive deleted"
      : result.writeback?.reason ? `; local deletion only (${result.writeback.reason})` : "";
    showToast(`Article deleted${suffix}`);
  } catch (error) { showToast(error.message); }
});

document.querySelector("[data-library-sync]").addEventListener("click", async () => {
  const status = document.querySelector("[data-library-status]");
  status.textContent = "Syncing GitHub";
  try {
    const result = await mutation("/api/admin/library/sync", { method: "POST" });
    await loadState();
    showToast(`GitHub sync complete: ${result.imported.length} imported, ${(result.deleted || []).length} deleted, ${result.errors.length} error(s)`);
  } catch (error) {
    status.textContent = error.message;
    showToast(error.message);
  }
});

document.querySelector("[data-logout]").addEventListener("click", async () => {
  try { await mutation("/api/admin/logout", { method: "POST" }); } catch {}
  csrfToken = "";
  setAuthenticated(false);
});

document.querySelector("[data-restore-input]").addEventListener("change", async (event) => {
  const file = event.currentTarget.files?.[0];
  if (!file) return;
  const accepted = await confirmAction({
    title: "Restore backup?",
    message: "Current Laboratory content will be replaced with the selected backup.",
    confirmLabel: "Restore backup",
    danger: true,
  });
  if (!accepted) {
    event.currentTarget.value = "";
    return;
  }
  const body = new FormData();
  body.append("file", file);
  try {
    await mutation("/api/admin/restore", { method: "POST", body });
    await loadState();
    showToast("Backup restored");
  } catch (error) { showToast(error.message); }
  event.currentTarget.value = "";
});

document.querySelector("[data-update-check]").addEventListener("click", async () => {
  const output = document.querySelector("[data-update-result]");
  output.textContent = "Checking releases";
  try {
    const result = await mutation("/api/updates/check", { method: "POST" });
    output.replaceChildren();
    if (!result.update_available) {
      output.textContent = `Laboratory ${result.installed_version} is current.`;
      return;
    }
    output.append(`Laboratory ${result.available_version} is available. `);
    const install = document.createElement("button");
    install.type = "button";
    install.className = "button-inline";
    install.textContent = "Install update";
    install.addEventListener("click", async () => {
      const accepted = await confirmAction({
        title: "Install update?",
        message: `Laboratory will create a backup and install version ${result.available_version}.`,
        confirmLabel: "Install update",
      });
      if (!accepted) return;
      try {
        const job = await mutation("/api/updates/apply", { method: "POST", body: JSON.stringify({ version: result.available_version }) });
        output.textContent = `Update job ${job.id} started.`;
      } catch (error) { output.textContent = error.message; }
    });
    output.appendChild(install);
  } catch (error) { output.textContent = error.message; }
});

document.querySelector("[data-neptune-save]").addEventListener("click", async () => {
  try {
    await mutation("/api/neptune/schedule", { method: "PUT", body: JSON.stringify({ enabled: neptuneEnabled.checked, interval_hours: Number(neptuneInterval.value) }) });
    await loadNeptune();
    showToast("Neptune schedule saved");
  } catch (error) { neptuneResult.textContent = error.message; }
});

document.querySelector("[data-neptune-run]").addEventListener("click", async () => {
  try {
    await mutation("/api/neptune/runs", { method: "POST" });
    await loadNeptune();
    showToast("Neptune backup accepted");
  } catch (error) { neptuneResult.textContent = error.message; }
});

document.querySelector("[data-neptune-check]").addEventListener("click", async () => {
  try {
    neptuneRelease = await mutation("/api/neptune/update/check", { method: "POST" });
    neptuneResult.textContent = neptuneRelease.update_available
      ? `Neptune ${neptuneRelease.available_version} is available.`
      : `Neptune ${neptuneStatus.version} is current.`;
    neptuneInstall.hidden = !neptuneRelease.update_available;
    neptuneInstall.textContent = neptuneRelease.update_available ? `Install Neptune ${neptuneRelease.available_version}` : "Install Neptune";
  } catch (error) { neptuneResult.textContent = error.message; }
});

neptuneInstall.addEventListener("click", async () => {
  if (!neptuneRelease?.available_version) return;
  try {
    await mutation("/api/neptune/update/install", { method: "POST", body: JSON.stringify({ version: neptuneRelease.available_version }) });
    neptuneInstall.hidden = true;
    neptuneRelease = null;
    await loadNeptune();
    showToast("Neptune updated");
  } catch (error) { neptuneResult.textContent = error.message; }
});

async function initialize() {
  bindThemeControls();
  try {
    const session = await api("/api/admin/session");
    csrfToken = session.csrfToken;
    document.querySelector("[data-session-label]").textContent = `Signed in as ${session.username}`;
    await loadState();
    setAuthenticated(true);
  } catch {
    setAuthenticated(false);
  }
}

initialize();
