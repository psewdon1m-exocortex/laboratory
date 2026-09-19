import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import profile from "./deployment-profile.json" with { type: "json" };

const SCHEMA = "exocortex.register.snapshot.v1";
const REVISION_PATTERN = /^register-[A-Za-z0-9-]+$/;
const VOLT_REFERENCE = /^volt:\/\/[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\/[1-5]$/i;
export const SECONDARY_SECRET_KEYS = {
  githubToken: "services.laboratory.credentials.github_token",
  githubWebhookSecret: "services.laboratory.credentials.github_webhook_secret",
  saturnClientToken: "services.laboratory.credentials.saturn_client_token",
  googleServiceAccountBase64: "services.laboratory.credentials.google_service_account_base64",
};
const LABORATORY_KEYS = [
  "repositories.laboratory.url",
  "repositories.neptune.url",
  "repositories.laboratory.content.url",
  "repositories.laboratory.content.branch",
  "services.laboratory.url",
  "services.laboratory.sni",
  "services.laboratory.port",
  "services.saturn.sni",
  "services.saturn.port",
  "intervals.kernel.refresh_sec",
  ...Object.values(SECONDARY_SECRET_KEYS),
  ...Object.keys(profile.keys),
];

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export function verifySnapshot(snapshot) {
  if (!snapshot || snapshot.schema !== SCHEMA) throw new Error("Unsupported Kernel Register schema");
  if (!REVISION_PATTERN.test(snapshot.revision ?? "")) throw new Error("Invalid Kernel Register revision");
  if (!snapshot.values || typeof snapshot.values !== "object" || Array.isArray(snapshot.values)) {
    throw new Error("Kernel Register values must be an object");
  }
  const digest = crypto.createHash("sha256").update(canonical({ values: snapshot.values })).digest("hex");
  if (snapshot.checksum !== `sha256:${digest}`) throw new Error("Kernel Register checksum mismatch");
  const check = (value) => {
    if (value && typeof value === "object" && !Array.isArray(value)) return Object.values(value).forEach(check);
    if (typeof value !== "string" || !VOLT_REFERENCE.test(value)) throw new Error("Kernel snapshot contains a non-reference value");
  };
  check(snapshot.values);
  return snapshot;
}

export function validateProfile(config, values) {
  const required = { ...profile.keys, ...Object.fromEntries(Object.entries(profile.conditionalKeys).filter(([flag]) => config[flag]).flatMap(([, keys]) => Object.entries(keys))) };
  for (const [key, type] of Object.entries(required)) {
    const value = resolve(values, key);
    if (typeof value !== "string" || !value || value.length > 8192 || /[\r\n\0]/.test(value)) throw new Error(`Missing or invalid Register key: ${key}`);
    let valid = true;
    if (type === "github-repository") { const url = new URL(value); valid = url.protocol === "https:" && url.host === "github.com" && !url.username && !url.password && !url.search && !url.hash && /^\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/?$/.test(url.pathname); }
    if (type === "git-branch") valid = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,119}$/.test(value) && !value.includes("..") && !value.includes("//") && !value.includes("@{") && !value.endsWith(".") && !value.endsWith("/") && value.split("/").every((part) => !part.startsWith(".") && !part.endsWith(".lock"));
    if (type === "hostname") valid = /^[A-Za-z0-9](?:[A-Za-z0-9.-]{0,251}[A-Za-z0-9])?$/.test(value) && !value.includes("..");
    if (type === "port") valid = /^[0-9]{1,5}$/.test(value) && Number(value) > 0 && Number(value) <= 65535;
    if (type === "path") valid = value.startsWith("/") && !value.startsWith("//") && !/[?#\\]/.test(value) && !value.split("/").some((p) => p === "." || p === "..");
    if (type === "health-contract") valid = ["private-readiness", "public-readiness", "public-liveness"].includes(value);
    if (type === "slug") valid = /^[a-z0-9][a-z0-9-]{0,63}$/.test(value);
    if (!valid) throw new Error(`Invalid ${type} in Register key: ${key}`);
  }
}

function resolve(values, dottedKey) {
  return dottedKey.split(".").reduce((current, part) => current?.[part], values);
}

function httpsUrl(value, name) {
  if (!value) return "";
  const parsed = new URL(value);
  if (parsed.protocol !== "https:" || !parsed.hostname) throw new Error(`${name} must be an HTTPS URL`);
  return value.replace(/\/$/, "");
}

export function applyLaboratoryRegister(config, snapshot) {
  const values = snapshot?.values;
  if (!values) return {
    repositoryUrl: config.repositoryUrl,
    neptuneRepositoryUrl: "",
    contentRepositoryUrl: "",
    contentRepositoryBranch: "",
    publicUrl: config.publicUrl,
    saturnUrl: config.saturnUrl,
    githubToken: "", githubWebhookSecret: "", saturnClientToken: "", googleServiceAccountBase64: "",
    refreshSeconds: config.kernelRefreshSeconds,
    revision: "",
  };
  const repositoryUrl = resolve(values, "repositories.laboratory.url")
    ? httpsUrl(resolve(values, "repositories.laboratory.url"), "repositories.laboratory.url")
    : config.repositoryUrl;
  const neptuneRepositoryUrl = resolve(values, "repositories.neptune.url")
    ? httpsUrl(resolve(values, "repositories.neptune.url"), "repositories.neptune.url")
    : "";
  const contentRepositoryUrl = resolve(values, "repositories.laboratory.content.url")
    ? httpsUrl(resolve(values, "repositories.laboratory.content.url"), "repositories.laboratory.content.url")
    : "";
  const registerBranch = String(resolve(values, "repositories.laboratory.content.branch") ?? "").trim();
  if (registerBranch && !/^[A-Za-z0-9._/-]{1,120}$/.test(registerBranch)) throw new Error("repositories.laboratory.content.branch is invalid");
  const contentRepositoryBranch = registerBranch;
  const explicitUrl = resolve(values, "services.laboratory.url");
  let publicUrl = config.publicUrl;
  if (explicitUrl) {
    publicUrl = httpsUrl(explicitUrl, "services.laboratory.url");
  } else {
    const sni = String(resolve(values, "services.laboratory.sni") ?? "").trim();
    if (sni) {
      if (!/^[A-Za-z0-9.-]+$/.test(sni)) throw new Error("services.laboratory.sni must contain only a hostname");
      const port = Number.parseInt(resolve(values, "services.laboratory.port") ?? "443", 10);
      if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("services.laboratory.port is invalid");
      publicUrl = `https://${sni}${port === 443 ? "" : `:${port}`}`;
    }
  }
  let saturnUrl = config.saturnUrl;
  const saturnSni = String(resolve(values, "services.saturn.sni") ?? "").trim();
  if (saturnSni) {
    if (!/^[A-Za-z0-9.-]+$/.test(saturnSni)) throw new Error("services.saturn.sni must contain only a hostname");
    const saturnPort = Number.parseInt(resolve(values, "services.saturn.port") ?? "443", 10);
    if (!Number.isInteger(saturnPort) || saturnPort < 1 || saturnPort > 65535) throw new Error("services.saturn.port is invalid");
    saturnUrl = `https://${saturnSni}${saturnPort === 443 ? "" : `:${saturnPort}`}`;
  }
  const sharedRefresh = Number.parseInt(resolve(values, "intervals.kernel.refresh_sec"), 10);
  const refreshSeconds = Number.isInteger(sharedRefresh) && sharedRefresh >= 5 && sharedRefresh <= 3600
    ? sharedRefresh
    : config.kernelRefreshSeconds;
  const credentials = Object.fromEntries(Object.entries(SECONDARY_SECRET_KEYS).map(([name, key]) => [name, String(resolve(values, key) ?? "")]));
  return { repositoryUrl, neptuneRepositoryUrl, contentRepositoryUrl, contentRepositoryBranch, publicUrl, saturnUrl, ...credentials, refreshSeconds, revision: snapshot.revision };
}

function withResolvedValues(snapshot, resolved) {
  const values = structuredClone(snapshot.values);
  for (const [key, item] of Object.entries(resolved)) {
    const parts = key.split(".");
    let cursor = values;
    for (const part of parts.slice(0, -1)) cursor = cursor[part];
    cursor[parts.at(-1)] = item.value;
  }
  return { ...snapshot, values };
}

async function readCache(cachePath) {
  return verifySnapshot(JSON.parse(await fs.readFile(cachePath, "utf8")));
}

async function writeCache(cachePath, snapshot) {
  await fs.mkdir(path.dirname(cachePath), { recursive: true });
  const temporary = `${cachePath}.${process.pid}.tmp`;
  await fs.writeFile(temporary, `${canonical(snapshot)}\n`, { encoding: "utf8", mode: 0o600 });
  await readCache(temporary);
  await fs.rename(temporary, cachePath);
}

export async function loadKernelSnapshot(config) {
  if (!config.kernelUrl && !config.kernelServiceToken) return null;
  let cached = null;
  try { cached = await readCache(config.kernelCachePath); } catch {}
  const headers = {
    Authorization: `Bearer ${config.kernelServiceToken}`,
    Accept: "application/vnd.exocortex.register+json; version=1",
    "User-Agent": `exocortex-laboratory/${config.version}`,
  };
  if (cached) headers["If-None-Match"] = `"${cached.revision}"`;
  try {
    const response = await fetch(`${config.kernelUrl.replace(/\/$/, "")}/api/v1/register/snapshot`, {
      headers,
      redirect: "error",
      signal: AbortSignal.timeout(config.kernelTimeoutMs),
    });
    if (response.status === 304 && cached) return cached;
    if (!response.ok) throw new Error(`Kernel returned HTTP ${response.status}`);
    const body = await response.text();
    if (Buffer.byteLength(body) > 3 * 1024 * 1024) throw new Error("Kernel Register response is too large");
    const snapshot = verifySnapshot(JSON.parse(body));
    await writeCache(config.kernelCachePath, snapshot);
    return snapshot;
  } catch (error) {
    if (cached) return cached;
    throw error;
  }
}

export async function resolveKernelValues(config, keys, fetchImpl = globalThis.fetch) {
  const response = await fetchImpl(`${config.kernelUrl.replace(/\/$/, "")}/api/v1/register/resolve`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${config.kernelServiceToken}`,
      "Content-Type": "application/json",
      Accept: "application/json",
      "User-Agent": `exocortex-laboratory/${config.version}`,
    },
    body: JSON.stringify({ keys }),
    redirect: "manual",
    signal: AbortSignal.timeout(config.kernelTimeoutMs),
  });
  if (!response.ok) throw new Error(`Kernel value resolution returned HTTP ${response.status}`);
  const text = await response.text();
  if (Buffer.byteLength(text) > 1024 * 1024) throw new Error("Kernel resolution response is too large");
  const payload = JSON.parse(text);
  if (payload?.schema !== "exocortex.register.resolution.v1" || !payload.values || typeof payload.values !== "object") {
    throw new Error("Kernel returned an unsupported resolution response");
  }
  for (const key of keys) {
    if (typeof payload.values[key]?.value !== "string") throw new Error("Kernel omitted a requested Register value");
  }
  return payload.values;
}

export class KernelRegisterRuntime {
  constructor(config) {
    this.config = config;
    this.state = applyLaboratoryRegister(config, null);
    this.error = "";
    this.timer = null;
  }

  async refresh() {
    if (this.pending) return this.pending;
    this.pending = this.refreshOnce();
    try { return await this.pending; } finally { this.pending = null; }
  }

  async refreshOnce() {
    try {
      const snapshot = await loadKernelSnapshot(this.config);
      let resolvedSnapshot = snapshot;
      if (snapshot) {
        const keys = [...new Set(LABORATORY_KEYS)].filter((key) => resolve(snapshot.values, key) !== undefined);
        for (const key of keys) {
          if (!VOLT_REFERENCE.test(String(resolve(snapshot.values, key)))) {
            throw new Error(`Kernel Register key ${key} must use volt://<entry-id>/<field-id>`);
          }
        }
        resolvedSnapshot = keys.length
          ? withResolvedValues(snapshot, await resolveKernelValues(this.config, keys))
          : snapshot;
        validateProfile(this.config, resolvedSnapshot.values);
      }
      const next = applyLaboratoryRegister(this.config, resolvedSnapshot);
      this.state = next;
      this.error = "";
    } catch (error) {
      this.error = error.message;
      this.state = { ...this.state, githubToken: "", githubWebhookSecret: "", saturnClientToken: "", googleServiceAccountBase64: "" };
    }
    return this.state;
  }

  async start() {
    await this.refresh();
    if (!this.config.kernelUrl) return;
    this.timer = setInterval(() => this.refresh(), this.state.refreshSeconds * 1000);
    this.timer.unref();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
  }
}
