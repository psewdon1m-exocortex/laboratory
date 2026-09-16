import { api, bindThemeControls, formatPublicationDate } from "./shared.js";

const loginCard = document.querySelector("[data-login-card]");
const loginForm = document.querySelector("[data-login-form]");
const protectedRoot = document.querySelector("[data-admin-protected]");
const identityForm = document.querySelector("[data-identity-form]");
const atmosphereForm = document.querySelector("[data-atmosphere-form]");
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
const editorAi = document.querySelector("[data-editor-ai]");
const editorAiStatus = document.querySelector("[data-editor-ai-status]");
const accessKeyDialog = document.querySelector("[data-access-key-dialog]");
const kernelTokenDialog = document.querySelector("[data-kernel-token-dialog]");
const updateDialog = document.querySelector("[data-update-dialog]");
const aiSettingsForm = document.querySelector("[data-ai-settings-form]");
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
const customSelectSync = new WeakMap();

function prepareTimeZoneSelect() {
  const select = document.querySelector("[data-time-zone]");
  const zones = typeof Intl.supportedValuesOf === "function"
    ? Intl.supportedValuesOf("timeZone")
    : ["UTC", "Europe/Istanbul", "Europe/London", "Europe/Berlin", "America/New_York", "America/Los_Angeles", "Asia/Dubai", "Asia/Tokyo"];
  select.replaceChildren();
  for (const zone of [...new Set(["UTC", ...zones])]) {
    const option = document.createElement("option");
    option.value = zone;
    option.textContent = zone.replaceAll("_", " ");
    select.appendChild(option);
  }
}

function closeCustomSelects(except = null) {
  document.querySelectorAll(".custom-select.is-open").forEach((root) => {
    if (root === except) return;
    root.classList.remove("is-open");
    root.querySelector(".custom-select-menu").hidden = true;
    root.querySelector(".custom-select-trigger").setAttribute("aria-expanded", "false");
  });
}

function enhanceSelect(select) {
  const root = document.createElement("div");
  root.className = "custom-select";
  const trigger = document.createElement("button");
  trigger.type = "button";
  trigger.className = "custom-select-trigger";
  trigger.setAttribute("aria-haspopup", "listbox");
  trigger.setAttribute("aria-expanded", "false");
  const menu = document.createElement("div");
  menu.className = "custom-select-menu";
  menu.role = "listbox";
  menu.hidden = true;
  select.before(root);
  root.append(select, trigger, menu);
  select.classList.add("native-select-hidden");
  const sync = () => {
    trigger.textContent = select.selectedOptions[0]?.textContent || "Select";
    menu.querySelectorAll("button").forEach((button) => button.classList.toggle("is-selected", button.dataset.value === select.value));
  };
  for (const option of select.options) {
    const item = document.createElement("button");
    item.type = "button";
    item.role = "option";
    item.dataset.value = option.value;
    item.textContent = option.textContent;
    item.addEventListener("click", () => {
      select.value = option.value;
      select.dispatchEvent(new Event("change", { bubbles: true }));
      closeCustomSelects();
      trigger.focus();
    });
    menu.appendChild(item);
  }
  trigger.addEventListener("click", (event) => {
    event.stopPropagation();
    const opening = !root.classList.contains("is-open");
    closeCustomSelects(root);
    root.classList.toggle("is-open", opening);
    menu.hidden = !opening;
    trigger.setAttribute("aria-expanded", String(opening));
  });
  select.addEventListener("change", sync);
  customSelectSync.set(select, sync);
  sync();
}

function syncCustomSelect(select) {
  customSelectSync.get(select)?.();
}

document.addEventListener("click", () => closeCustomSelects());

const uploads = [
  { slot: "heroImage", label: "Hero image", recommendation: "Recommended: 1680 × 720 px", accept: "image/png,image/jpeg,image/webp,image/avif,image/gif" },
  { slot: "aboutImage", label: "About Me choice image", recommendation: "Recommended: 1680 × 720 px", accept: "image/png,image/jpeg,image/webp,image/avif,image/gif" },
  { slot: "journalImage", label: "Journal choice image", recommendation: "Recommended: 1680 × 720 px", accept: "image/png,image/jpeg,image/webp,image/avif,image/gif" },
  { slot: "webIcon", label: "Web Icon", recommendation: "Recommended: 512 × 512 px, PNG", accept: "image/png,image/webp,image/avif" },
  { slot: "socialImage", label: "Link preview image", recommendation: "Recommended: 1731 × 909 px, PNG", accept: "image/png" },
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
  identityForm.siteTitle.value = content.siteTitle || "";
  identityForm.heroTitle.value = content.heroTitle || "";
  identityForm.heroSubtitle.value = content.heroSubtitle || "";
  identityForm.aboutTitle.value = content.pages?.about?.title || "";
  identityForm.journalTitle.value = content.pages?.journal?.title || "";
  identityForm.timeZone.value = content.settings?.timeZone || "UTC";
  atmosphereForm.themeDefault.value = content.settings?.themeDefault || "system";
  atmosphereForm.noiseEnabled.checked = Boolean(content.settings?.noise?.enabled);
  atmosphereForm.noiseIntensity.value = String(content.settings?.noise?.intensity ?? 32);
  atmosphereForm.noiseGrain.value = String(content.settings?.noise?.grain ?? 55);
  syncCustomSelect(identityForm.timeZone);
  syncCustomSelect(atmosphereForm.themeDefault);
}

function refreshFavicon() {
  const icon = document.querySelector("link[rel='icon']");
  if (icon) icon.href = `/favicon.png?v=${Date.now()}`;
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
      ${definition.recommendation ? `<span class="upload-recommendation">${definition.recommendation}</span>` : ""}
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
        if (definition.slot === "webIcon") refreshFavicon();
        showToast(`${definition.label} uploaded`);
      } catch (error) { showToast(error.message); }
    });
    item.querySelector("button").addEventListener("click", async () => {
      try {
        const next = await mutation(`/api/admin/upload/${definition.slot}`, { method: "DELETE" });
        currentState.content = next;
        renderUploads(next);
        if (definition.slot === "webIcon") refreshFavicon();
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
    row.setAttribute("aria-expanded", String(selectedArticleId === article.internalId && editor.open));
    row.addEventListener("click", () => {
      if (selectedArticleId === article.internalId && editor.open) closeArticleEditor();
      else openArticleEditor(article.internalId);
    });
    articlesRoot.appendChild(row);
  }
}

function closeArticleEditor() {
  selectedArticleId = "";
  if (editor.open) editor.close();
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
  if (!editor.open) editor.showModal();
  document.querySelector("[data-editor-id]").textContent = `${article.internalId} · revision ${article.revision}`;
  document.querySelector("[data-editor-heading]").textContent = article.title;
  document.querySelector("[data-editor-download]").href = `/api/admin/articles/${encodeURIComponent(article.internalId)}/archive`;
  editorForm.title.value = article.title;
  editorForm.slug.value = article.slug;
  editorForm.status.value = article.status;
  syncCustomSelect(editorForm.status);
  editorForm.markdownSource.value = article.markdownSource || "";
  document.querySelector("[data-markdown-field]").hidden = article.format !== "markdown";
  const generation = article.generationJob;
  editorAiStatus.hidden = !generation;
  if (generation) {
    const usage = generation.usage || {};
    editorAiStatus.textContent = [
      `AI pipeline: ${generation.status}`,
      `attempts ${generation.attempts}`,
      usage.totalTokenCount != null ? `${usage.totalTokenCount} tokens` : "",
      usage.finishReason ? `finish ${usage.finishReason}` : "",
      generation.lastError ? `error: ${generation.lastError}` : "",
    ].filter(Boolean).join(" · ");
  } else {
    editorAiStatus.textContent = "";
  }
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
  document.querySelector("[data-kernel-form] [name=url]").value = runtime.kernelUrl || "";
  runtimeItem("Kernel revision", runtime.registerRevision || runtime.registerError || "Local mode");
  runtimeItem("Repository", runtime.repositoryUrl);
  runtimeItem("Article repository", runtime.contentLibrary?.repositoryUrl);
  runtimeItem("Article branch", runtime.contentLibrary?.branch);
  runtimeItem("Last article sync", runtime.contentLibrary?.lastSyncAt || runtime.contentLibrary?.lastError);
  runtimeItem("Public URL", runtime.publicUrl);
  document.querySelector("[data-update-version]").textContent = runtime.version || "Unknown";
  document.querySelector("[data-update-dialog-version]").textContent = runtime.version || "Unknown";
  document.querySelector("[data-updater-status]").textContent = runtime.updater?.available
    ? `${runtime.updater.status} / ${runtime.updater.version}`
    : "Not connected";
}

function renderNeptune(status) {
  neptuneRuntime.replaceChildren();
  runtimeItemInto(neptuneRuntime, "Client", status.client_instance_id);
  runtimeItemInto(neptuneRuntime, "Version", `${status.product} ${status.version}`);
  runtimeItemInto(neptuneRuntime, "State", status.active ? "Backup active" : (status.latest_run_state || "Ready"));
  runtimeItemInto(neptuneRuntime, "Last success", status.last_success_at || "Never");
  runtimeItemInto(neptuneRuntime, "Next run", status.project.next_run_at || "Not scheduled");
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

async function loadAiSettings() {
  const settings = await api("/api/admin/ai");
  aiSettingsForm.enabled.checked = Boolean(settings.enabled);
  aiSettingsForm.prompt.value = settings.prompt || "";
  document.querySelector("[data-ai-credential]").textContent = settings.configured
    ? "API key: connected through Kernel Register / Volt"
    : "API key: unavailable in Kernel Register";
  document.querySelector("[data-ai-model]").textContent = `Provider: ${settings.provider} · Model: ${settings.model}`;
}

loginForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  try {
    const session = await api("/api/admin/login", {
      method: "POST",
      body: JSON.stringify({ access_key: loginForm.access_key.value }),
    });
    csrfToken = session.csrfToken;
    await loadState();
    await loadAiSettings();
    setAuthenticated(true);
    loginForm.reset();
  } catch (error) { showToast(error.message); }
});

function contentPayload() {
  const content = currentState.content;
  return {
    siteTitle: content.siteTitle,
    heroTitle: content.heroTitle,
    heroSubtitle: content.heroSubtitle,
    pages: {
      about: { title: content.pages?.about?.title },
      journal: { title: content.pages?.journal?.title },
    },
    settings: {
      timeZone: content.settings?.timeZone,
      themeDefault: content.settings?.themeDefault,
      noise: {
        enabled: Boolean(content.settings?.noise?.enabled),
        intensity: Number(content.settings?.noise?.intensity ?? 32),
        grain: Number(content.settings?.noise?.grain ?? 55),
      },
    },
  };
}

async function saveContent(payload, message) {
  try {
    const content = await mutation("/api/admin/content", { method: "PUT", body: JSON.stringify(payload) });
    currentState.content = content;
    fillContent(content);
    showToast(message);
  } catch (error) { showToast(error.message); }
}

identityForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const payload = contentPayload();
  payload.siteTitle = identityForm.siteTitle.value.trim();
  payload.heroTitle = identityForm.heroTitle.value.trim();
  payload.heroSubtitle = identityForm.heroSubtitle.value.trim();
  payload.pages.about.title = identityForm.aboutTitle.value.trim();
  payload.pages.journal.title = identityForm.journalTitle.value.trim();
  payload.settings.timeZone = identityForm.timeZone.value.trim();
  await saveContent(payload, "Identity saved");
});

atmosphereForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const payload = contentPayload();
  payload.settings.themeDefault = atmosphereForm.themeDefault.value;
  payload.settings.noise = {
    enabled: atmosphereForm.noiseEnabled.checked,
    intensity: Number(atmosphereForm.noiseIntensity.value),
    grain: Number(atmosphereForm.noiseGrain.value),
  };
  await saveContent(payload, "Atmosphere saved");
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
    await refreshAfterArticleChange(result, "Article imported");
  } catch (error) { showToast(error.message); }
});

aiSettingsForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const button = aiSettingsForm.querySelector("button[type=submit]");
  button.disabled = true;
  try {
    const settings = await mutation("/api/admin/ai", {
      method: "PUT",
      body: JSON.stringify({ enabled: aiSettingsForm.enabled.checked, prompt: aiSettingsForm.prompt.value }),
    });
    aiSettingsForm.prompt.value = settings.prompt;
    await loadAiSettings();
    showToast("AI pipeline settings saved");
  } catch (error) { showToast(error.message); }
  finally { button.disabled = false; }
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

editorAi.addEventListener("click", async () => {
  if (!selectedArticleId) return;
  const label = editorAi.textContent;
  editorAi.disabled = true;
  editorAi.textContent = "Applying...";
  try {
    await mutation(`/api/admin/articles/${encodeURIComponent(selectedArticleId)}/derivatives/regenerate`, { method: "POST" });
    editorAiStatus.hidden = false;
    editorAiStatus.textContent = "AI pipeline: pending · attempts 0";
    showToast("AI pipeline queued. Existing generated data will be replaced.");
  } catch (error) { showToast(error.message); }
  finally {
    editorAi.disabled = false;
    editorAi.textContent = label;
  }
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

editorCollapse.addEventListener("click", closeArticleEditor);
editor.addEventListener("cancel", (event) => { event.preventDefault(); });
editor.addEventListener("click", (event) => { if (event.target === editor) closeArticleEditor(); });

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
    window.location.assign("/private"); return;
    await loadState();
    showToast("Backup restored");
  } catch (error) { showToast(error.message); }
  event.currentTarget.value = "";
});

document.querySelector("[data-update-check]").addEventListener("click", async () => {
  const output = document.querySelector("[data-update-result]");
  if (!updateDialog.open) updateDialog.showModal();
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
        await waitJob(job, output);
      } catch (error) {
        if (!isRestartWindowError(error)) {
          output.textContent = error.message;
          return;
        }
        try {
          await waitForLaboratoryRestart(output);
          window.location.reload();
        } catch (restartError) { output.textContent = restartError.message; }
      }
    });
    output.appendChild(install);
  } catch (error) { output.textContent = error.message; }
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
  prepareTimeZoneSelect();
  document.querySelectorAll("select").forEach(enhanceSelect);
  document.querySelectorAll("form").forEach((form) => form.addEventListener("reset", () => requestAnimationFrame(() => {
    form.querySelectorAll("select").forEach(syncCustomSelect);
  })));
  try {
    const session = await api("/api/admin/session");
    csrfToken = session.csrfToken;
    await loadState();
    await loadAiSettings();
    setAuthenticated(true);
  } catch {
    setAuthenticated(false);
  }
}

initialize();

const jobPollDelay = 2000;

function isRestartWindowError(error) {
  return /(?:502\s+Bad Gateway|503\s+Service Unavailable|504\s+Gateway|Failed to fetch|NetworkError|Load failed)/i
    .test(String(error?.message || error || ""));
}

function waitForPoll() {
  return new Promise((resolve) => setTimeout(resolve, jobPollDelay));
}

async function waitForLaboratoryRestart(output) {
  let consecutiveHealthyResponses = 0;
  for (let attempt = 0; attempt < 90; attempt++) {
    output.textContent = "Laboratory is restarting. Waiting for it to return...";
    try {
      const response = await fetch("/api/live", { cache: "no-store", credentials: "same-origin" });
      consecutiveHealthyResponses = response.ok ? consecutiveHealthyResponses + 1 : 0;
      if (consecutiveHealthyResponses >= 2) return;
    } catch {
      consecutiveHealthyResponses = 0;
    }
    await waitForPoll();
  }
  throw new Error("Laboratory did not return after the update. Check the Updater job and service logs.");
}

async function waitJob(started, output) {
  if (!started.id) throw new Error("Updater omitted the operation id");
  let restartWindowFailures = 0;
  for (let attempt = 0; attempt < 300; attempt++) {
    let job;
    try {
      job = await api("/api/updates/jobs/" + encodeURIComponent(started.id));
      restartWindowFailures = 0;
    } catch (error) {
      if (!isRestartWindowError(error) || restartWindowFailures >= 90) throw error;
      restartWindowFailures += 1;
      output.textContent = "Laboratory is restarting. Update monitoring will resume automatically...";
      await waitForPoll();
      continue;
    }
    output.textContent = job.state + ": " + (job.message || "");
    if (job.state === "COMPLETED") return job;
    if (["FAILED", "ROLLED_BACK", "ROLLBACK_FAILED"].includes(job.state)) throw new Error(job.message || job.state);
    await waitForPoll();
  }
  throw new Error("Operation still running. Check status before retrying.");
}
document.querySelector("[data-neptune-initialize]").addEventListener("submit", async (event) => {
  event.preventDefault(); const form = event.currentTarget, button = form.querySelector("button"); button.disabled = true;
  try { const job = await mutation("/api/neptune/initialize", { method: "POST", body: JSON.stringify(Object.fromEntries(new FormData(form))) }); form.reset(); await waitJob(job, neptuneResult); await loadNeptune(); }
  catch (error) { neptuneResult.textContent = error.message; } finally { button.disabled = false; }
});
for (const [selector, route] of [["[data-access-key-form]", "/api/admin/security/access-key"], ["[data-kernel-form]", "/api/admin/security/kernel"]]) {
  document.querySelector(selector).addEventListener("submit", async (event) => {
    event.preventDefault(); const form = event.currentTarget, button = form.querySelector("button"); button.disabled = true;
    try { const result = await mutation(route, { method: "PUT", body: JSON.stringify(Object.fromEntries(new FormData(form))) }); if (result.csrfToken) csrfToken = result.csrfToken; form.reset(); if (selector === "[data-access-key-form]" && accessKeyDialog.open) accessKeyDialog.close(); await loadState(); showToast("Validated and saved"); }
    catch (error) { showToast(error.message); } finally { button.disabled = false; }
  });
}
document.querySelector("[data-access-key-open]").addEventListener("click", () => accessKeyDialog.showModal());
document.querySelector("[data-access-key-close]").addEventListener("click", () => accessKeyDialog.close());
accessKeyDialog.addEventListener("click", (event) => { if (event.target === accessKeyDialog) accessKeyDialog.close(); });
document.querySelector("[data-kernel-token-open]").addEventListener("click", () => kernelTokenDialog.showModal());
document.querySelector("[data-kernel-token-close]").addEventListener("click", () => kernelTokenDialog.close());
kernelTokenDialog.addEventListener("click", (event) => { if (event.target === kernelTokenDialog) kernelTokenDialog.close(); });
document.querySelector("[data-kernel-token-form]").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const button = form.querySelector("button[type=submit]");
  button.disabled = true;
  try {
    const payload = Object.fromEntries(new FormData(form));
    payload.url = document.querySelector("[data-kernel-form] [name=url]").value;
    await mutation("/api/admin/security/kernel", { method: "PUT", body: JSON.stringify(payload) });
    form.reset();
    kernelTokenDialog.close();
    await loadState();
    showToast("Kernel token saved");
  } catch (error) { showToast(error.message); }
  finally { button.disabled = false; }
});
document.querySelector("[data-update-close]").addEventListener("click", () => updateDialog.close());
updateDialog.addEventListener("click", (event) => { if (event.target === updateDialog) updateDialog.close(); });
document.querySelector("[data-updater-self]").addEventListener("click", async (event) => {
  const button = event.currentTarget; button.disabled = true;
  const output = document.querySelector("[data-updater-result]");
  try { await waitJob(await mutation("/api/updates/agent/install", {method:"POST"}), output); await loadState(); }
  catch (error) { showToast(error.message); } finally { button.disabled = false; }
});
