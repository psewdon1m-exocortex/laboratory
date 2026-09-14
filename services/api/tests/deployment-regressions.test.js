import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { zipSync, strToU8 } from "fflate";
import { OperatorSecurity, createSession, authMiddleware } from "../src/auth.js";
import { createLaboratoryApp } from "../src/server.js";
import { parseArticleArchive } from "../src/article-archive.js";
import { LaboratoryStore } from "../src/storage.js";
import { createBackup, parseBackup, parseBackupAsync } from "../src/backup.js";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

test("operator session revocation is durable and rotated verifier recovers without plaintext", () => {
  const db = new DatabaseSync(":memory:");
  const config = { accessKey: "synthetic-old-access-key", adminUsername: "operator", sessionSecret: "synthetic-session-secret-for-regression" };
  const security = new OperatorSecurity(db, config);
  const first = createSession("operator", config.sessionSecret, security.generation());
  const req = { cookies: { laboratory_session: first.token } };
  assert.ok(authMiddleware(config, security).session(req));
  security.revoke(first.token, Date.now()+3600000);
  assert.equal(authMiddleware(config, new OperatorSecurity(db, config)).session(req), null);
  security.rotate("synthetic-rotated-access-key");
  const recovery = security.snapshot();
  security.rotate("synthetic-temporary-access-key");
  const previous = security.generation();
  security.restore(recovery);
  assert.ok(security.verify("synthetic-rotated-access-key"));
  assert.ok(!security.verify(config.accessKey));
  assert.ok(security.generation() > previous);
  assert.doesNotMatch(JSON.stringify(recovery), /synthetic-/);
  db.close();
});

test("large archive compression and restore validation leave the event loop responsive", async context => {
  const dataDir=await fs.mkdtemp(path.join(os.tmpdir(),"laboratory-backup-responsiveness-"));
  const store=await LaboratoryStore.open({dataDir,accessKey:"synthetic-responsiveness-key",defaultsDir:fileURLToPath(new URL("../../../data/defaults/",import.meta.url))});
  context.after(async()=>{store.close();await fs.rm(dataDir,{recursive:true,force:true});});
  const random=crypto.randomBytes(16*1024*1024);
  const read=store.backupFiles.bind(store);
  store.backupFiles=async snapshot=>({...await read(snapshot),"synthetic-load.bin":random});
  let ticks=0;const timer=setInterval(()=>{ticks++;},10);
  try {
    const archive=await createBackup(store,"0.1.2-test");
    const compressionTicks=ticks;ticks=0;
    const parsed=await parseBackupAsync(archive);
    assert.equal(parsed.files["synthetic-load.bin"].length,random.length);
    assert.ok(compressionTicks>=2,"compression blocked ordinary requests");
    assert.ok(ticks>=2,"archive validation blocked ordinary requests");
    const corrupted=Buffer.from(archive);corrupted[100]^=255;
    await assert.rejects(parseBackupAsync(corrupted));
  } finally {clearInterval(timer);}
});

test("interrupted restore journal recovers both sides of the database commit", async context => {
  const dataDir=await fs.mkdtemp(path.join(os.tmpdir(),"laboratory-crash-restore-"));
  const config={dataDir,defaultsDir:fileURLToPath(new URL("../../../data/defaults/",import.meta.url))};
  let store=await LaboratoryStore.open(config);
  context.after(async()=>{store.close();await fs.rm(dataDir,{recursive:true,force:true});});
  for(const committed of [false,true]) {
    const operation=committed?"abcdef1234567890":"1234567890abcdef";
    const rollback=path.join(dataDir,`.restore-rollback-${operation}`);
    await fs.writeFile(path.join(store.uploadsDir,"marker"),"original");
    await fs.rename(store.uploadsDir,rollback);
    await fs.mkdir(store.uploadsDir);await fs.writeFile(path.join(store.uploadsDir,"marker"),"replacement");
    await fs.writeFile(path.join(dataDir,"restore-journal.json"),JSON.stringify({operation}));
    if(committed)store.db.prepare("INSERT INTO restore_commits VALUES (?)").run(operation);
    store.close();store=await LaboratoryStore.open(config);
    assert.equal(await fs.readFile(path.join(store.uploadsDir,"marker"),"utf8"),committed?"replacement":"original");
    await assert.rejects(fs.stat(rollback),/ENOENT/);
    await assert.rejects(fs.stat(path.join(dataDir,"restore-journal.json")),/ENOENT/);
  }
});

test("database failure after file switch rolls back content, files and security generation", async context => {
  const dataDir=await fs.mkdtemp(path.join(os.tmpdir(),"laboratory-commit-failure-"));
  const store=await LaboratoryStore.open({dataDir,accessKey:"synthetic-crash-recovery-key",defaultsDir:fileURLToPath(new URL("../../../data/defaults/",import.meta.url))});
  context.after(async()=>{store.close();await fs.rm(dataDir,{recursive:true,force:true});});
  const parsed=parseBackup(await createBackup(store,"0.1.2-test"));
  const original=store.getContent();original.siteTitle="Retain original state";store.updateContent(original);
  await fs.writeFile(path.join(store.uploadsDir,"survivor"),"still here");
  const generation=store.security.generation();
  store.db.exec("CREATE TRIGGER synthetic_commit_failure BEFORE INSERT ON restore_commits BEGIN SELECT RAISE(ABORT,'injected commit failure'); END");
  await assert.rejects(store.restoreSnapshot(parsed.snapshot,parsed.files),/injected commit failure/);
  assert.equal(store.getContent().siteTitle,original.siteTitle);
  assert.equal(await fs.readFile(path.join(store.uploadsDir,"survivor"),"utf8"),"still here");
  assert.equal(store.security.generation(),generation);
  store.db.exec("DROP TRIGGER synthetic_commit_failure");
  const invalid=structuredClone(parsed.snapshot);
  const bad=Buffer.from("not an image");
  invalid.assets=[{slot:"heroImage",filename:"invalid.png",original_name:"invalid.png",mime:"image/png",size:bad.length,sha256:crypto.createHash("sha256").update(bad).digest("hex"),updated_at:new Date().toISOString()}];
  await assert.rejects(store.restoreSnapshot(invalid,{"assets/heroImage/invalid.png":bad}),/Unsupported image format/);
  assert.equal(store.getContent().siteTitle,original.siteTitle);
  await store.restoreSnapshot(parsed.snapshot,parsed.files);
  assert.ok(store.security.generation()>generation);
});

test("Access Key-only HTTP login, logout replay, draft raw ACL and private cache policy", async context => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "laboratory-security-regression-"));
  const app = await createLaboratoryApp({ dataDir, port:0, accessKey:"synthetic-http-access-key", sessionSecret:"synthetic-long-session-secret-for-http-regression", kernelUrl:"", kernelServiceToken:"", cookieSecure:false, derivedContentEnabled:false });
  const runtime = app.locals.laboratory;
  const server = await new Promise(resolve => { const instance=app.listen(0,"127.0.0.1",()=>resolve(instance)); });
  const origin = `http://127.0.0.1:${server.address().port}`;
  context.after(async()=>{
    await new Promise(resolve=>server.close(resolve));
    runtime.register.stop();runtime.githubLibrary.stop();runtime.derivedContent.stop();runtime.searchNotifications.stop();runtime.store.close();
    await runtime.audit.queue;
    assert.ok(path.resolve(dataDir).startsWith(path.resolve(os.tmpdir())+path.sep));
    await fs.rm(dataDir,{recursive:true,force:true});
  });
  const login = await fetch(origin+"/api/admin/login",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({access_key:"synthetic-http-access-key"})});
  assert.equal(login.status,200);
  const cookie=login.headers.get("set-cookie").split(";")[0], {csrfToken}=await login.json();
  const state=await fetch(origin+"/api/admin/state",{headers:{Cookie:cookie}});
  assert.match(state.headers.get("cache-control"),/no-store/);
  runtime.store.restoreInProgress=true;
  assert.equal((await fetch(origin+"/api/live")).status,200);
  assert.equal((await fetch(origin+"/api/health")).status,503);
  runtime.store.restoreInProgress=false;
  const archive=Buffer.from(zipSync({"article.md":strToU8("# Synthetic closed draft\nPRIVATE_DRAFT_CANARY\n")}));
  const imported=await runtime.store.library.importArchive(parseArticleArchive(archive,{archiveName:"Closed draft.zip",status:"unpublished"}));
  const file=runtime.store.library.revisionFiles(runtime.store.library.articleRowByReference(imported.article.internalId).current_revision_id)[0];
  const raw=origin+"/api/media/library/"+file.storagePath;
  assert.equal((await fetch(raw)).status,404);
  const preview=await fetch(raw,{headers:{Cookie:cookie}});
  assert.equal(preview.status,200);assert.match(preview.headers.get("cache-control"),/no-store/);
  // Hold a real archive request inside asynchronous file collection. Concurrent
  // restore bodies must be rejected before multer allocates memory, while the
  // health endpoint remains responsive. Disconnecting the first client must
  // not admit a second worker until the first operation actually finishes.
  let releaseRead, enteredRead;
  const entered = new Promise(resolve => { enteredRead=resolve; });
  const release = new Promise(resolve => { releaseRead=resolve; });
  const originalRead=runtime.store.backupFiles.bind(runtime.store);
  runtime.store.backupFiles=async snapshot=>{enteredRead();await release;return originalRead(snapshot);};
  const controller=new AbortController();
  const pending=fetch(origin+"/api/admin/backup",{headers:{Cookie:cookie},signal:controller.signal}).catch(error=>error);
  await entered;
  assert.equal((await fetch(origin+"/api/health")).status,200);
  const concurrent=await fetch(origin+"/api/admin/restore",{method:"POST",headers:{Cookie:cookie,"X-CSRF-Token":csrfToken,"Content-Type":"multipart/form-data; boundary=synthetic"},body:"invalid body intentionally never parsed"});
  assert.equal(concurrent.status,409);
  controller.abort();await pending;
  assert.equal((await fetch(origin+"/api/admin/backup",{headers:{Cookie:cookie}})).status,409);
  releaseRead();runtime.store.backupFiles=originalRead;
  let recovered;
  for(let attempt=0;attempt<50;attempt++){
    recovered=await fetch(origin+"/api/admin/backup",{headers:{Cookie:cookie}});
    await recovered.arrayBuffer();
    if(recovered.status===200)break;
    await new Promise(resolve=>setTimeout(resolve,10));
  }
  assert.equal(recovered.status,200,"archive lease was not released after the disconnected worker finished");
  const logout=await fetch(origin+"/api/admin/logout",{method:"POST",headers:{Cookie:cookie,"X-CSRF-Token":csrfToken}});
  assert.equal(logout.status,200);
  assert.equal((await fetch(origin+"/api/admin/state",{headers:{Cookie:cookie}})).status,401);
  assert.equal((await fetch(raw,{headers:{Cookie:cookie}})).status,404);
});
