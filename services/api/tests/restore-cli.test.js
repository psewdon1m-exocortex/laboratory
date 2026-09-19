import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { loadConfig } from "../src/config.js";
import { LaboratoryStore } from "../src/storage.js";
import { createBackup } from "../src/backup.js";
import { restoreArchive } from "../src/restore-cli.js";

test("offline rollback restores a legacy ZIP with AI settings without another archive", async t => {
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),"laboratory-offline-"));t.after(()=>fs.rm(dir,{recursive:true,force:true}));
 const config=loadConfig({dataDir:path.join(dir,"data"),kernelUrl:"",kernelServiceToken:"",accessKey:"synthetic-offline-key",sessionSecret:"synthetic-offline-session-secret-long-enough",derivedContentEnabled:false});
 let store=await LaboratoryStore.open(config);
 const prompt="Synthetic operator prompt retained from a previous release. ".repeat(2);
 store.db.prepare("INSERT OR REPLACE INTO settings(key,value) VALUES (?,?)").run("aiSystemPrompt",prompt);
 store.db.prepare("INSERT OR REPLACE INTO settings(key,value) VALUES (?,?)").run("aiPipelineEnabled","false");
 const bytes=await createBackup(store,"0.1.5"),archive=path.join(dir,"operator.zip");await fs.writeFile(archive,bytes);
 store.db.prepare("UPDATE settings SET value=? WHERE key='siteTitle'").run("Must be restored");store.close();
 const result=await restoreArchive(archive,config);assert.ok(result.settings>0);
 store=await LaboratoryStore.open(config);
 try {assert.equal(store.db.prepare("SELECT value FROM settings WHERE key='aiSystemPrompt'").get().value,prompt);assert.notEqual(store.getContent().siteTitle,"Must be restored");}
 finally {store.close();}
 assert.deepEqual(await fs.readFile(archive),bytes);
 const scan=async p=>(await fs.readdir(p,{withFileTypes:true})).flatMap(x=>x.isFile()?[x.name]:[]);
 assert.deepEqual((await scan(config.dataDir)).filter(x=>x.endsWith('.zip')),[]);
 await fs.writeFile(archive,"invalid");await assert.rejects(restoreArchive(archive,config));
});
