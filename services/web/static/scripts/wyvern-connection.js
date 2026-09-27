import { bindActionGeometry, bindDialogInteraction } from "./ui-interactions.js";
import { confirmAgentAction } from "./agent-initialize.js";

function node(tag, text, className) {
  const element = document.createElement(tag);
  if (text !== undefined) element.textContent = String(text);
  if (className) element.className = className;
  return element;
}

export function mountWyvernConnection(root, options) {
  const stopGeometry = bindActionGeometry(root);
  const storageKey = "exocortex.wyvern-binding.v1." + options.service;
  let status, failure = "", closed = false, loading = false, saving = false, modal;
  let pending;
  try { pending = JSON.parse(localStorage.getItem(storageKey) || "null"); } catch { /* The server remains authoritative. */ }

  function remember(value) {
    pending = value;
    try { value ? localStorage.setItem(storageKey, JSON.stringify(value)) : localStorage.removeItem(storageKey); } catch { /* Retry can still use this page's state. */ }
  }

  const functions = () => Object.entries(status?.functions || {});
  const binding = name => status?.bindings?.[name] || status?.functions?.[name];
  const bound = value => Boolean(value?.adapter_id && value?.profile);
  const hasBinding = () => functions().some(([name]) => bound(binding(name)));
  const adapterName = value => status?.adapters?.find(item => item.adapter_id === value?.adapter_id)?.name || value?.adapter_id || "unknown";
  const statusRow = (label, ready, waiting = false) => {
    const row = node("div", undefined, "exo-agent-status");
    row.dataset.state = waiting ? "unknown" : ready ? "ready" : "unavailable";
    const result = node("strong", waiting ? "Checking" : ready ? "Reachability" : "Unavailable");
    const square = node("i"); square.setAttribute("aria-hidden", "true"); result.append(square);
    row.append(node("span", label), result);
    return row;
  };

  function render() {
    if (closed) return;
    root.replaceChildren(); root.classList.add("exo-wyvern-connection");
    const group = node("section", undefined, "exo-agent-group exo-wyvern-binding");
    group.append(node("h3", "Wyverne adapter binding"),
      node("p", "Wyvern owns provider access. This service uses only its permitted Adapters."));
    const observations = node("div", undefined, "exo-wyvern-observations");
    observations.append(statusRow("Local Wyverne agent:", status?.reachable === true, !status && !failure),
      statusRow("Active adapter status:", status?.llm_ready === true, !status && !failure));
    group.append(observations);
    const message = failure || (status?.reachable === false ? status.code || "Wyvern is unavailable." : "");
    if (message) {
      const error = node("p", message.replaceAll("_", " "), "exo-agent-error exo-wyvern-error");
      error.setAttribute("role", "alert"); group.append(error);
    }
    if (status?.link_configured === false) group.append(node("p", "Install and link Wyvern with sudo updater tui on the host.", "exo-wyvern-guidance"));
    const selected = functions().filter(([name]) => bound(binding(name)));
    const names = [...new Set(selected.map(([name]) => adapterName(binding(name))))];
    const summary = names.length ? names.join(", ") : "none";
    if (names.length || status?.reachable !== false) group.append(node("p", "Active adapter: " + summary, "exo-wyvern-active"));
    const action = node("button", hasBinding() ? "Change Wyverne function" : "Link Wyverne function", "exo-wyvern-action" + (hasBinding() ? " is-bound" : ""));
    action.type = "button"; action.disabled = saving; action.onclick = openChoices;
    group.append(action); root.append(group);
  }

  async function refresh() {
    if (closed || loading || saving || modal) return;
    loading = true;
    try { status = await options.status(); failure = ""; }
    catch (error) { status = { ...status, reachable: false, llm_ready: false }; failure = error.message; }
    finally { loading = false; render(); }
  }

  function permittedChoices(name) {
    const required = status?.functions?.[name]?.required_capabilities || [];
    const selected = binding(name);
    const choices = [];
    for (const adapter of status?.adapters || []) for (const [profile, data] of Object.entries(adapter.profiles || {})) {
      if (!required.every(capability => (data.capabilities || []).includes(capability)) &&
          !(selected?.adapter_id === adapter.adapter_id && selected?.profile === profile)) continue;
      choices.push({ adapter, profile, data, available: adapter.enabled && required.every(capability => (data.capabilities || []).includes(capability)) });
    }
    return choices;
  }

  async function changeBindings(next, expected) {
    const same = pending && pending.expected_revision === expected && JSON.stringify(pending.bindings) === JSON.stringify(next);
    const request = same ? pending : { bindings: next, expected_revision: expected, request_id: crypto.randomUUID() };
    remember(request); saving = true;
    try {
      await options.bind(request);
      const verified = await options.status();
      const actual = verified.bindings || {};
      const matches = Object.keys(actual).length === Object.keys(next).length && Object.entries(next).every(([name, value]) =>
        actual[name]?.adapter_id === value.adapter_id && actual[name]?.profile === value.profile);
      if (!matches) throw new Error("The updated binding is not yet verified. Retry status before another change.");
      status = verified; failure = ""; remember(null);
      modal?.close(); render();
      return true;
    } catch (error) {
      failure = error.message;
      if (error.status === 409) {
        remember(null);
        try { status = await options.status(); } catch { /* Keep the last observed selection. */ }
        failure = "Binding changed elsewhere. Review the refreshed choices before applying.";
      }
      if (modal) modal.querySelector(".exo-wyvern-choice-error").textContent = failure;
      return false;
    } finally { saving = false; render(); }
  }

  function openChoices() {
    if (closed || modal) return;
    const previous = document.activeElement;
    const dialog = node("dialog", undefined, "exo-wyvern-choice" + (options.theme ? " " + options.theme : ""));
    modal = dialog;
    const header = node("header", undefined, "exo-wyvern-choice-header");
    const title = node("h2", "Wyverne Connection"); title.id = "wyvern-choice-" + crypto.randomUUID();
    dialog.setAttribute("aria-labelledby", title.id);
    const close = node("button", "×", "exo-wyvern-choice-close");
    close.type = "button"; close.setAttribute("aria-label", "Close Wyverne Connection");
    close.onclick = () => { if (!saving) dialog.close(); }; header.append(title, close);
    const body = node("div", undefined, "exo-wyvern-choice-body");
    body.append(node("p", "Select an Adapter already granted to this service through Wyvern", "exo-wyvern-choice-intro"));
    const names = functions().map(([name]) => name);
    let current = names.find(name => bound(binding(name))) || names[0];
    if (names.length > 1) {
      const label = node("label", "Function", "exo-wyvern-function-label");
      const select = node("select"); select.setAttribute("aria-label", "Wyverne function");
      for (const name of names) { const option = node("option", name); option.value = name; select.append(option); }
      select.value = current; select.onchange = () => { current = select.value; drawChoices(); };
      label.append(select); body.append(label);
    }
    const layout = node("div", undefined, "exo-wyvern-choice-layout");
    const list = node("div", undefined, "exo-wyvern-choice-list");
    const details = node("div", undefined, "exo-wyvern-choice-details");
    layout.append(list, details); body.append(layout);
    const error = node("p", "", "exo-wyvern-choice-error"); error.setAttribute("role", "alert"); body.append(error);
    const unlink = node("button", "Unlink all adapters", "exo-wyvern-unlink"); unlink.type = "button";
    if (hasBinding()) body.append(unlink);
    dialog.append(header, body);

    function drawChoices() {
      list.replaceChildren(); details.replaceChildren();
      const choices = current ? permittedChoices(current) : [];
      if (!status?.reachable) list.append(node("p", "Wyvern is unavailable. The last known selection remains saved. Install or repair it with sudo updater tui."));
      else if (!current) list.append(node("p", "No service functions are available. Link this client with sudo updater tui."));
      else if (!choices.length) list.append(node("p", "No permitted Adapters are available. Configure an Adapter for this client with sudo updater tui."));
      for (const choice of choices) {
        const active = binding(current);
        const selected = active?.adapter_id === choice.adapter.adapter_id && active?.profile === choice.profile;
        const row = node("button", undefined, "exo-wyvern-choice-row" + (selected ? " is-selected" : ""));
        row.type = "button"; row.disabled = !status?.reachable || !choice.available || saving;
        row.setAttribute("aria-pressed", String(selected));
        const mark = node("span", undefined, "exo-wyvern-choice-mark"); mark.setAttribute("aria-hidden", "true");
        row.append(mark, node("span", "@" + choice.adapter.adapter_id + (Object.keys(choice.adapter.profiles || {}).length > 1 ? " / " + choice.profile : "")));
        if (!choice.available) row.append(node("span", "Unavailable", "exo-wyvern-choice-unavailable"));
        row.onclick = async () => {
          if (saving) return;
          if (selected && status?.functions?.[current]?.ready) return;
          const approved = await confirmAgentAction({ title: "Change Adapter binding", message: "Apply " + choice.adapter.name + " / " + choice.profile + " to " + current + " for this service? Other service bindings remain unchanged.", confirmLabel: "Apply binding", theme: options.theme });
          if (!approved) return;
          const next = { ...(status.bindings || {}) };
          next[current] = { adapter_id: choice.adapter.adapter_id, profile: choice.profile };
          const expected = status.binding_revision;
          await changeBindings(next, expected);
          if (dialog.open) drawChoices();
        };
        list.append(row);
        if (selected) {
          details.append(node("strong", "Active adapter config:"), node("span", "Adapter: " + choice.adapter.name),
            node("span", "Profile: " + choice.profile), node("span", "Function: " + current),
            node("span", "Capabilities: " + (choice.data.capabilities || []).join(", ")),
            node("span", "Readiness: " + (status?.functions?.[current]?.ready ? "Ready" : "Unavailable")));
        }
      }
      details.hidden = !details.childElementCount;
      layout.classList.toggle("has-details", !details.hidden);
    }

    unlink.onclick = async () => {
      if (saving) return;
      if (!status?.reachable) { error.textContent = "Reconnect Wyvern before changing this service's bindings."; return; }
      const approved = await confirmAgentAction({ title: "Unlink service Adapters", message: "Remove all Wyvern function bindings for this service? Shared Adapters and other services remain unchanged.", confirmLabel: "Unlink all adapters", theme: options.theme });
      if (approved) await changeBindings({}, status.binding_revision);
    };
    dialog.addEventListener("cancel", event => { if (saving) event.preventDefault(); });
    dialog.addEventListener("close", () => {
      modal = null; dialog.remove(); render();
      const target = root.querySelector(".exo-wyvern-action");
      if (target) target.focus(); else if (previous?.isConnected) previous.focus();
      void refresh();
    }, { once: true });
    document.body.append(dialog); dialog.showModal();
    bindDialogInteraction(dialog);
    const stopDialogGeometry = bindActionGeometry(dialog);
    dialog.addEventListener("close", stopDialogGeometry, { once: true });
    drawChoices(); close.focus();
  }

  render(); void refresh();
  const timer = setInterval(() => { if (!document.hidden) void refresh(); }, 15000);
  return { refresh, close() { closed = true; clearInterval(timer); modal?.close(); stopGeometry(); root.replaceChildren(); } };
}
