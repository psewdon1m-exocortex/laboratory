import fs from "node:fs/promises";
import { constants, createReadStream } from "node:fs";
import http from "node:http";
import https from "node:https";

export class WyvernError extends Error {
  constructor(code, status = 503) { super(code); this.code = code; this.status = status; }
}
export class Wyvern {
  constructor({ linkFile = "/run/wyvern-link/link.json" } = {}) { this.linkFile = linkFile; this.lastStatus = { llm_ready: false, reachable: false, client_linked: false }; }
  async link() {
    let file;
    try {
      file = await fs.open(this.linkFile, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
      const stat = await file.stat();
      if (!stat.isFile() || stat.size > 4096 || process.platform !== "win32" && stat.mode & 0o007) throw Error();
      const value = JSON.parse(await file.readFile("utf8"));
      if (value.schema !== "exocortex.wyvern.link.v1" || !/^[a-f0-9]{64}$/.test(value.token) || !/^[a-z][a-z0-9_-]{0,63}$/.test(value.client_id) || !/^[a-z][a-z0-9_-]{0,63}$/.test(value.instance_id)) throw Error();
      if (value.mode === "local") { if (value.socket !== "/run/wyvern/client.sock" || value.url) throw Error(); }
      else if (value.mode === "remote") { const url = new URL(value.url); if (url.protocol !== "https:" || !url.hostname || url.username || url.password || url.search || url.hash || value.socket) throw Error(); }
      else throw Error();
      return value;
    } catch { throw new WyvernError("wyvern_not_configured"); }
    finally { await file?.close(); }
  }
  async call(method, route, { data, stream, size, mime, func, timeout = 300000 } = {}) {
    let link;
    try { link = await this.link(); } catch (error) { stream?.destroy(); throw error; }
    const target = new URL(link.mode === "local" ? "http://wyvern.local" : link.url);
    target.pathname = target.pathname.replace(/\/$/, "") + route;
    const body = data === undefined ? undefined : Buffer.from(JSON.stringify(data));
    return new Promise((resolve, reject) => {
      const fail = error => reject(error instanceof WyvernError ? error : new WyvernError("wyvern_unavailable"));
      const request = (target.protocol === "https:" ? https : http).request(target, {
        method, socketPath: link.mode === "local" ? link.socket : undefined,
        headers: { Authorization: "Bearer " + link.token, "Accept-Encoding": "identity", ...(body ? { "Content-Type": "application/json", "Content-Length": body.length } : {}),
          ...(stream ? { "Content-Type": mime, "Content-Length": size, "X-Wyvern-Function": func } : {}) },
      }, response => {
        if (response.headers["content-encoding"] && response.headers["content-encoding"] !== "identity") { response.destroy(); fail(new WyvernError("wyvern_response_invalid")); return; }
        if (response.statusCode < 200 || response.statusCode >= 300) { response.resume(); fail(new WyvernError(response.statusCode === 410 ? "wyvern_media_expired" : response.statusCode === 409 ? "wyvern_conflict" : "wyvern_request_rejected", response.statusCode)); return; }
        const chunks = []; let bytes = 0;
        response.on("data", chunk => { bytes += chunk.length; if (bytes > 2*1024**2) response.destroy(new WyvernError("wyvern_response_invalid")); else chunks.push(chunk); });
        response.on("error", fail);
        response.on("end", () => { try { const value = JSON.parse(Buffer.concat(chunks)); if (!value || typeof value !== "object" || Array.isArray(value)) throw Error(); resolve(value); } catch { fail(new WyvernError("wyvern_response_invalid")); } });
      });
      const timer = setTimeout(() => request.destroy(new WyvernError("wyvern_timeout")), timeout); timer.unref();
      request.on("error", fail); request.on("close", () => { clearTimeout(timer); stream?.destroy(); });
      if (stream) { stream.on("error", error => request.destroy(error)); stream.pipe(request); } else request.end(body);
    });
  }
  async status() {
    try {
      const link = await this.link(), result = await this.call("GET", "/v1/client", { timeout: 8000 });
      if (result.schema !== "exocortex.wyvern.client.v1" || result.client_id !== link.client_id || result.instance_id !== link.instance_id) throw new WyvernError("wyvern_identity_mismatch");
      this.lastStatus = { ...result, mode: link.mode, link_configured: true };
    } catch (error) { this.lastStatus = { reachable: false, client_linked: false, llm_ready: false, link_configured: error.code !== "wyvern_not_configured", code: error instanceof WyvernError ? error.code : "wyvern_unavailable" }; }
    return this.lastStatus;
  }
  async upload(filename, mime = "application/pdf") {
    const stat = await fs.stat(filename);
    if (!stat.isFile() || stat.size < 1 || stat.size > 50*1024**2) throw new WyvernError("wyvern_media_limit", 413);
    return this.call("POST", "/v1/media", { stream: createReadStream(filename), size: stat.size, mime, func: "derivatives" });
  }
  media(id, method = "GET") {
    if (!/^media_[a-f0-9-]{36}$/.test(id)) throw new WyvernError("wyvern_media_expired", 410);
    return this.call(method, "/v1/media/" + id);
  }
}
