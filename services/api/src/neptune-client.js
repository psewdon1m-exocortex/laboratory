import fs from "node:fs";
import http from "node:http";

function call(config, method, route, body = null, timeout = 30_000) {
  if (!config.neptuneControlTokenFile) throw Object.assign(new Error("Neptune control token is not configured"), { status: 503 });
  let token;
  try { token = fs.readFileSync(config.neptuneControlTokenFile, "utf8").trim(); }
  catch { throw Object.assign(new Error("Neptune control token is unavailable"), { status: 503 }); }
  const payload = body == null ? null : Buffer.from(JSON.stringify(body));
  return new Promise((resolve, reject) => {
    const request = http.request({
      socketPath: config.neptuneSocketPath,
      path: `/v1/projects/${encodeURIComponent(config.neptuneProjectId)}${route}`,
      method,
      timeout,
      headers: {
        Host: "neptune.local", Accept: "application/json", "X-Neptune-Token": token,
        ...(payload ? { "Content-Type": "application/json", "Content-Length": String(payload.length) } : {}),
      },
    }, (response) => {
      const chunks = [];
      let size = 0;
      response.on("data", (chunk) => {
        size += chunk.length;
        if (size > 1024 * 1024) request.destroy(new Error("Neptune response exceeds 1 MB"));
        else chunks.push(chunk);
      });
      response.on("end", () => {
        let value = {};
        try { value = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}"); }
        catch { reject(Object.assign(new Error("Neptune returned invalid JSON"), { status: 502 })); return; }
        if (response.statusCode < 200 || response.statusCode >= 300) {
          reject(Object.assign(new Error(value.error || `Neptune returned HTTP ${response.statusCode}`), { status: response.statusCode === 409 ? 409 : 502 }));
        } else resolve(value);
      });
    });
    request.on("timeout", () => request.destroy(new Error("Neptune request timed out")));
    request.on("error", (error) => reject(Object.assign(new Error(
      ["ENOENT", "ECONNREFUSED", "EACCES"].includes(error.code) ? "Neptune is not installed or is unavailable on this VPS" : error.message,
    ), { status: ["ENOENT", "ECONNREFUSED", "EACCES"].includes(error.code) ? 503 : 502 })));
    if (payload) request.write(payload);
    request.end();
  });
}

export function createNeptuneClient(config) {
  return {
    status: () => call(config, "GET", "/status"),
    schedule: (enabled, intervalHours) => call(config, "PUT", "/schedule", { enabled, intervalHours }),
    run: () => call(config, "POST", "/runs"),
  };
}
