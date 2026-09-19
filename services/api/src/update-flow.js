import express from "express";
import { createHash } from "node:crypto";
import { backupReceipt, savedBackup } from "./update-backup.js";

// The head owns authentication and its standard backup builder. The privileged
// daemon owns release discovery, signature verification and durable jobs.
export function mountUpdateFlow(app, { prefix, service, helpers = ["updater", "neptune"], authorize, mutation = [], headId, token, client, buildBackup, onJob, backupGuard = action => action }) {
  const router = express.Router();
  router.use(authorize);
  const stable = value => typeof value === "string" && /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(value);
  const fail = message => Object.assign(new Error(message), { status: 400 });
  const wrap = action => async (req, res, next) => { try { await action(req, res); } catch (error) { next(error); } };
  const id = value => { if (!/^[A-Za-z0-9-]{1,128}$/.test(value)) throw fail("Invalid update job"); return value; };
  const check = async component => {
    if (![service, ...helpers].includes(component)) throw fail("This service does not use the requested component");
    const health = await client.status();
    if (health.update_protocol !== 2) throw Object.assign(new Error("Updater 0.5.0 or later is required for the saved-copy update protocol"), { status: 426 });
    return client.request("POST", "/v2/check", { head_id: headId, component });
  };
  let creating = false;
  router.post("/check", ...mutation, wrap(async (req, res) => res.json(await check(req.body?.component))));
  router.post("/backup", ...mutation, backupGuard(wrap(async (req, res) => {
    const version = req.body?.version;
    if (!stable(version)) throw fail("Select a stable release");
    if (!token()) throw fail("Updater control token is unavailable");
    const candidate = await check(service);
    if (!candidate.update_available || candidate.available_version !== version) throw fail("Release changed; check again");
    if (creating) throw Object.assign(new Error("A backup is already being created"), { status: 409 });
    creating = true;
    try {
      const { archive, filename } = await buildBackup();
      const signed = backupReceipt(archive, filename, service, headId, version, token());
      res.set({ "Content-Type": "application/zip", "Content-Disposition": `attachment; filename="${filename}"`, "X-Update-Receipt": signed, "Cache-Control": "no-store" }).send(archive);
    } finally { creating = false; }
  })));
  router.post("/install/:component", ...mutation, express.raw({ type: "application/octet-stream", limit: "128mb" }), wrap(async (req, res) => {
    const component = req.params.component;
    let job;
    if (component === service) {
      if (req.get("X-Update-Saved") !== "1" || !Buffer.isBuffer(req.body)) throw fail("Save the standard ZIP on your computer before installing");
      let payload;
      try { payload = savedBackup(req.body, req.get("X-Update-Receipt") || "", token(), service, headId); }
      catch (error) { throw fail(error.message); }
      finally { req.body.fill(0); }
      job = await client.request("POST", "/v2/updates", payload);
    } else {
      if (!helpers.includes(component) || !stable(req.body?.version) || !/^[0-9a-f-]{36}$/i.test(req.body?.request_id ?? "")) throw fail("An exact stable component version and request ID are required");
      job = await client.request("POST", `/v2/components/${component}/updates`, { head_id: headId, version: req.body.version, request_id: req.body.request_id });
    }
    onJob?.(job); res.status(202).json(job);
  }));
  router.get("/jobs", wrap(async (_req, res) => res.json(await client.request("GET", `/v1/jobs?head_id=${encodeURIComponent(headId)}`))));
  router.get("/jobs/:id", wrap(async (req, res) => res.json(await client.request("GET", `/v1/jobs/${id(req.params.id)}`))));
  router.post("/jobs/:id/rollback", ...mutation, express.raw({ type: "application/octet-stream", limit: "128mb" }), wrap(async (req, res) => {
    if (!Buffer.isBuffer(req.body) || req.body.length === 0) throw fail("Upload the original pre-update ZIP");
    const backup = { filename: "backup.zip", sha256: createHash("sha256").update(req.body).digest("hex"), data_base64: req.body.toString("base64") };
    req.body.fill(0); res.status(202).json(await client.request("POST", `/v2/jobs/${id(req.params.id)}/rollback`, backup));
  }));
  app.use(prefix, router);
}
