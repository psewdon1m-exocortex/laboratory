import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import http from "node:http";
import { once } from "node:events";
import { LaboratoryStore } from "../src/storage.js";
import { createBackup, parseBackup } from "../src/backup.js";
import { INTENT_SCHEMA, readIntent, validateIntent, saveIntent } from "../src/wyvern-intent.js";

const selected = { schema: INTENT_SCHEMA, state: "observed", instance_id: "source-host", client_id: "laboratory", revision: 7,
  bindings: { derivatives: { adapter_id: "google", profile: "default" } } };

test("logical archive restores own Wyvern intent into a clean instance without writing shared state", async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "lab-wyvern-backup-"));
  const defaultsDir = fileURLToPath(new URL("../../../data/defaults/", import.meta.url));
  const source = await LaboratoryStore.open({ dataDir: path.join(root, "source"), defaultsDir, wyvernLinkFile: path.join(root, "missing") });
  const target = await LaboratoryStore.open({ dataDir: path.join(root, "target"), defaultsDir, wyvernLinkFile: path.join(root, "missing") });
  t.after(async () => { source.close(); target.close(); await fs.rm(root, { recursive: true, force: true }); });
  source.wyvern.exportIntent = async () => structuredClone(selected);
  const parsed = parseBackup(await createBackup(source, "test"));
  assert.deepEqual(parsed.snapshot.wyvern, selected);
  target.wyvern.call = async () => { throw Error("Restore must not call Wyvern"); };
  await target.restoreSnapshot(parsed.snapshot, parsed.files);
  assert.deepEqual(readIntent(target.db), { ...selected, state: "pending_verification" });
  assert.deepEqual(parseBackup(await createBackup(target, "test")).snapshot.wyvern, readIntent(target.db));
  const invalid = { ...parsed.snapshot, wyvern: { ...selected, token: "must-not-enter-archive" } };
  await assert.rejects(target.restoreSnapshot(invalid, parsed.files), /Invalid Wyvern recovery intent/);
  assert.deepEqual(readIntent(target.db), { ...selected, state: "pending_verification" });
  const legacy = { ...parsed.snapshot, schema: "exocortex.laboratory.backup.v3" }; delete legacy.wyvern;
  await target.restoreSnapshot(legacy, parsed.files);
  assert.deepEqual(readIntent(target.db), { ...selected, state: "pending_verification" });
});

test("configured missing gateway blocks export, and intent schema forbids credentials", async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "lab-wyvern-unavailable-"));
  const store = await LaboratoryStore.open({ dataDir: root, defaultsDir: fileURLToPath(new URL("../../../data/defaults/", import.meta.url)), wyvernLinkFile: path.join(root, "missing") });
  t.after(async () => { store.close(); await fs.rm(root, { recursive: true, force: true }); });
  saveIntent(store.db, selected);
  await assert.rejects(createBackup(store, "test"), { code: "wyvern_backup_unavailable" });
  assert.throws(() => validateIntent({ ...selected, bindings: { derivatives: { ...selected.bindings.derivatives, api_key: "secret" } } }));
});

test("restored intent blocks requests to a different scope or Adapter until bindings match", async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "lab-wyvern-pending-"));
  const store = await LaboratoryStore.open({ dataDir: root, defaultsDir: fileURLToPath(new URL("../../../data/defaults/", import.meta.url)) });
  saveIntent(store.db, { ...selected, state: "pending_verification" });
  let status = { schema: "exocortex.wyvern.client.v1", ...selected, instance_id: "different-host", llm_ready: true }, generated = 0;
  const server = http.createServer((request, response) => {
    if (request.url === "/v1/client") response.end(JSON.stringify({ ...status, schema: "exocortex.wyvern.client.v1" }));
    else { generated++; request.resume(); response.end(JSON.stringify({ result: "ok" })); }
  });
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); store.close(); await fs.rm(root, { recursive: true, force: true }); });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  store.wyvern.link = async () => ({ mode: "remote", url: `http://127.0.0.1:${server.address().port}`, token: "a".repeat(64), client_id: "laboratory", instance_id: status.instance_id });
  assert.equal((await store.wyvern.status()).code, "wyvern_restore_pending");
  await assert.rejects(store.wyvern.call("POST", "/v1/generate", { data: {} }), { code: "wyvern_restore_pending" });
  status = { ...status, instance_id: selected.instance_id, bindings: { derivatives: { adapter_id: "other", profile: "default" } } };
  await assert.rejects(store.wyvern.call("POST", "/v1/count-tokens", { data: {} }), { code: "wyvern_restore_pending" });
  assert.equal(generated, 0);
  status.bindings = selected.bindings;
  assert.equal((await store.wyvern.status()).llm_ready, true);
  assert.deepEqual(await store.wyvern.call("POST", "/v1/generate", { data: {} }), { result: "ok" });
  assert.equal(generated, 1);
});
