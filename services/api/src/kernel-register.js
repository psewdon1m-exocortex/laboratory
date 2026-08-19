import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

const SCHEMA = "exocortex.register.snapshot.v1";
const REVISION_PATTERN = /^register-[A-Za-z0-9-]+$/;

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
  return snapshot;
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
    contentRepositoryUrl: "",
    contentRepositoryBranch: "",
    publicUrl: config.publicUrl,
    geminiApiKey: "",
    refreshSeconds: config.kernelRefreshSeconds,
    revision: "",
  };
  const repositoryUrl = resolve(values, "repositories.laboratory.url")
    ? httpsUrl(resolve(values, "repositories.laboratory.url"), "repositories.laboratory.url")
    : config.repositoryUrl;
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
  const sharedRefresh = Number.parseInt(resolve(values, "intervals.kernel.refresh_sec"), 10);
  const refreshSeconds = Number.isInteger(sharedRefresh) && sharedRefresh >= 5 && sharedRefresh <= 3600
    ? sharedRefresh
    : config.kernelRefreshSeconds;
  const geminiApiKey = String(resolve(values, "services.laboratory.ai.gemini_api_key") ?? "").trim();
  return { repositoryUrl, contentRepositoryUrl, contentRepositoryBranch, publicUrl, geminiApiKey, refreshSeconds, revision: snapshot.revision };
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

export class KernelRegisterRuntime {
  constructor(config) {
    this.config = config;
    this.state = applyLaboratoryRegister(config, null);
    this.error = "";
    this.timer = null;
  }

  async refresh() {
    try {
      const snapshot = await loadKernelSnapshot(this.config);
      this.state = applyLaboratoryRegister(this.config, snapshot);
      this.error = "";
    } catch (error) {
      this.error = error.message;
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
