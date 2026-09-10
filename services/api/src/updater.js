import crypto from "node:crypto";
import http from "node:http";

export class UpdaterClient {
  constructor(config) {
    this.socketPath = config.updaterSocketPath;
    this.controlToken = config.updaterControlToken;
    this.headId = config.updaterHeadId;
  }

  request(method, route, body = null, authenticated = false, timeout = 10_000) {
    return new Promise((resolve, reject) => {
      const payload = body == null ? null : Buffer.from(JSON.stringify(body));
      const headers = { Host: "updater.local", Accept: "application/json" };
      if (payload) {
        headers["Content-Type"] = "application/json";
        headers["Content-Length"] = String(payload.length);
      }
      if (authenticated) headers["X-Updater-Token"] = this.controlToken;
      const request = http.request({ socketPath: this.socketPath, path: route, method, headers, timeout }, (response) => {
        const chunks = [];
        let size = 0;
        response.on("data", (chunk) => {
          size += chunk.length;
          if (size > 4 * 1024 * 1024) request.destroy(new Error("Updater response is too large"));
          else chunks.push(chunk);
        });
        response.on("end", () => {
          let value = {};
          try { value = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}"); } catch {}
          if (response.statusCode < 200 || response.statusCode >= 300) {
            reject(new Error(value.error || `Updater returned HTTP ${response.statusCode}`));
          } else resolve(value);
        });
      });
      request.on("timeout", () => request.destroy(new Error("Updater request timed out")));
      request.on("error", reject);
      if (payload) request.write(payload);
      request.end();
    });
  }

  async status() {
    try {
      return { available: true, ...(await this.request("GET", "/v1/health")) };
    } catch (error) {
      return { available: false, status: "unavailable", message: error.message };
    }
  }

  createUpdate(version, backupName, backupData) {
    const checksum = crypto.createHash("sha256").update(backupData).digest("hex");
    const requestId = crypto.createHash("sha256").update(`${this.headId}:${version}:${checksum}`).digest("hex");
    return this.request("POST", "/v1/updates", {
      request_id: requestId,
      head_id: this.headId,
      service: "laboratory",
      version,
      backup: {
        filename: backupName,
        sha256: checksum,
        data_base64: backupData.toString("base64"),
        restore_url: "/api/internal/updater/restore",
      },
    }, true, 30_000);
  }

  job(id) {
    return this.request("GET", `/v1/jobs/${encodeURIComponent(id)}`);
  }

  rollback(id) {
    return this.request("POST", `/v1/jobs/${encodeURIComponent(id)}/rollback`, null, true, 30_000);
  }

  updateNeptune(version) {
    return this.request("POST", "/v1/components/neptune-linux/update", {
      head_id: this.headId,
      version,
    }, true, 300_000);
  }
}

function versionTuple(value) {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/.exec(value ?? "");
  return match ? [Number(match[1]), Number(match[2]), Number(match[3]), match[4] ?? ""] : null;
}

function compareVersions(left, right) {
  for (let index = 0; index < 3; index += 1) {
    if (left[index] !== right[index]) return left[index] - right[index];
  }
  if (left[3] === right[3]) return 0;
  if (!left[3]) return 1;
  if (!right[3]) return -1;
  return left[3].localeCompare(right[3]);
}

export async function checkGithubRelease(repositoryUrl, currentVersion, timeoutMs = 5000, service = "laboratory") {
  if (!repositoryUrl) throw new Error(`repositories.${service}.url is not configured`);
  const parsed = new URL(repositoryUrl);
  const segments = parsed.pathname.replace(/\.git$/, "").split("/").filter(Boolean);
  if (parsed.protocol !== "https:" || parsed.hostname !== "github.com" || segments.length !== 2) {
    throw new Error(`${service} repository must be an HTTPS GitHub repository`);
  }
  const response = await fetch(`https://api.github.com/repos/${segments[0]}/${segments[1]}/releases?per_page=100`, {
    headers: { Accept: "application/vnd.github+json", "User-Agent": `exocortex-${service}` },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) throw new Error(`GitHub returned HTTP ${response.status}`);
  const releases = await response.json();
  const candidates = releases
    .filter((release) => !release.draft && !release.prerelease && release.tag_name?.startsWith(`${service}-v`))
    .map((release) => ({ version: release.tag_name.slice(`${service}-v`.length), release }))
    .map((item) => ({ ...item, tuple: versionTuple(item.version) }))
    .filter((item) => item.tuple)
    .sort((a, b) => compareVersions(b.tuple, a.tuple));
  const current = versionTuple(currentVersion) ?? [0, 0, 0, ""];
  const available = candidates.find((item) => compareVersions(item.tuple, current) > 0);
  return {
    repository_url: repositoryUrl,
    installed_version: currentVersion,
    available_version: available?.version ?? null,
    release_url: available?.release?.html_url ?? null,
    update_available: Boolean(available),
    backup_required: true,
  };
}
