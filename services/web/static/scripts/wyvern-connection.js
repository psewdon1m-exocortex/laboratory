import { confirmAgentAction } from "./agent-initialize.js";
function node(tag, text) { const item = document.createElement(tag); if (text !== undefined) item.textContent = String(text); return item; }
export function mountWyvernConnection(root, options) {
  let status, failure = "", closed = false, loading = false, dirty = false, saving = false, draftRevision;
  const drafts = new Map();
  const key = "exocortex.wyvern-binding.v1." + options.service;
  let pending; try { pending = JSON.parse(localStorage.getItem(key) || "null"); } catch {}
  const remember = value => { pending = value; try { value ? localStorage.setItem(key, JSON.stringify(value)) : localStorage.removeItem(key); } catch {} };
  const truth = value => value === true ? "Yes" : value === false ? "No" : "Unknown";
  function render() {
    if (closed || root.contains(document.activeElement) && document.activeElement.matches("select")) return;
    root.replaceChildren(); root.classList.add("exo-wyvern-connection");
    const group = title => { const box = node("section"); box.className = "exo-agent-group"; box.append(node("h3", title)); root.append(box); return box; };
    const button = (label, action) => { const item = node("button", label); item.type = "button"; item.onclick = () => void action(); return item; };
    const identity = group("Gateway");
    identity.append(node("p", "Wyvern owns provider access. Applications use only their permitted Adapters."),
      node("p", "Instance: " + (status?.instance_id || "Unknown") + " · Transport: " + (status?.mode || "Unknown")),
      node("p", "Reachable: " + truth(status?.reachable) + " · Last verified: " + (status?.last_verified_at ? new Date(status.last_verified_at).toLocaleString() : "Not reported")));
    const reachability = node("div"); reachability.className = "exo-agent-status";
    reachability.dataset.state = status?.reachable === true ? "ready" : status?.reachable === false ? "unavailable" : "unknown";
    const indicator = node("strong", status?.reachable === true ? "Service Reachability" : status?.reachable === false ? "Service Unavailable" : "Checking");
    const square = node("i"); square.setAttribute("aria-hidden", "true"); indicator.append(square);
    reachability.append(node("span", "Local Wyverne agent:"), indicator); identity.append(reachability);
    const error = node("p", failure || status?.code || ""); error.className = "exo-agent-error"; error.setAttribute("role", "alert"); identity.append(error);
    const connection = group("Client connection");
    connection.append(node("p", "Client: " + (status?.client_id || options.service) + " · Authenticated: " + truth(status?.client_linked)),
      button("Initialize", options.initialize), button("Retry status", refresh));
    const adapters = group("Allowed Adapter");
    adapters.append(node("p", status?.llm_ready ? "Required functions are ready." : "Select a permitted Adapter and verify every required function."));
    for (const [name, fn] of Object.entries(status?.functions || {})) {
      const bound = fn.adapter_id ? fn.adapter_id + ":" + fn.profile : "";
      if (!dirty) drafts.set(name, bound);
      const label = node("label", name), select = node("select"); select.setAttribute("aria-label", "Adapter for " + name);
      select.add(new Option("Not linked", ""));
      const required = fn.required_capabilities || [];
      for (const adapter of status?.adapters || []) for (const [profile, data] of Object.entries(adapter.profiles || {})) {
        if (adapter.enabled && required.every(capability => (data.capabilities || []).includes(capability)))
          select.add(new Option(adapter.name + " / " + profile, adapter.adapter_id + ":" + profile));
      }
      const selected = drafts.get(name) ?? bound;
      if (selected && !Array.from(select.options).some(option => option.value === selected)) {
        const retained = new Option(selected + " · unavailable", selected); retained.disabled = true; select.add(retained);
      }
      select.value = selected; select.disabled = !status?.reachable || saving;
      select.onchange = () => { if (!dirty) draftRevision = status.binding_revision; dirty = true; drafts.set(name, select.value); };
      label.append(select); adapters.append(label, node("p", "Readiness: " + truth(fn.ready) + (fn.code ? " · " + fn.code : "")));
    }
    const apply = button("Apply Adapter binding", async () => {
      const bindings = Object.fromEntries([...drafts].filter(([,value]) => value).map(([name,value]) => {
        const [adapter_id, profile] = value.split(":"); return [name, { adapter_id, profile }];
      }));
      const expected = dirty ? draftRevision : status?.binding_revision;
      const same = pending && JSON.stringify(pending.bindings) === JSON.stringify(bindings);
      const request = same ? pending : { bindings, expected_revision: expected, request_id: crypto.randomUUID() };
      const summary = [...drafts].map(([name, value]) => name + ": " + (value || "unlink")).join("; ");
      if (!await confirmAgentAction({ title: "Change Adapter binding", message: "Apply these bindings only to this service: " + summary + ". In-flight work keeps its accepted configuration. Future requests use the selected Adapter.", confirmLabel: "Apply binding", theme: options.theme })) return;
      remember(request); saving = true; render();
      try {
        await options.bind(request);
        const verified = await options.status();
        for (const [name, value] of drafts) {
          const actual = verified.functions?.[name];
          if ((actual?.adapter_id ? actual.adapter_id + ":" + actual.profile : "") !== value) throw new Error("The updated binding is not yet verified. Retry status before another change.");
        }
        status = verified; remember(null); dirty = false; failure = "";
      } catch (error) { failure = error.message; if (error.status === 409) { remember(null); dirty = false; } }
      finally { saving = false; render(); }
    });
    apply.disabled = !status?.reachable || saving || !Object.keys(status?.functions || {}).length; adapters.append(apply);
    adapters.append(button("Open gateway management", async () => {
      try {
        const { url } = await options.management();
        const destination = new URL(url);
        if (destination.protocol !== "https:" || destination.username || destination.password) throw new Error("The authorized management destination is invalid");
        location.assign(destination.href);
      } catch (error) { failure = error.message; render(); }
    }));
    const version = group("Wyvern version");
    version.append(node("p", "Current installed version: " + (status?.version || status?.gateway_version || "Unavailable")),
      button("Check Wyvern for updates", options.update));
  }
  async function refresh() {
    if (closed || loading || saving) return;
    loading = true;
    try { const observed = await options.status(); if (!closed) { status = observed; failure = ""; render(); } }
    catch (error) { if (!closed) { status = { ...status, reachable: false, client_linked: false, llm_ready: false }; failure = error.message; render(); } }
    finally { loading = false; }
  }
  render(); void refresh();
  const timer = setInterval(() => { if (!document.hidden) void refresh(); }, 15000);
  return { refresh, close() { closed = true; clearInterval(timer); root.replaceChildren(); } };
}
