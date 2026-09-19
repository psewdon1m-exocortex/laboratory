import assert from "node:assert/strict";
import test from "node:test";
import { checkGithubRelease } from "../src/updater.js";
test("legacy discovery also excludes unqualified, draft and prerelease versions", async t => {
 const service="laboratory";
 const releases=[{tag_name:service+"-v1.0.9"},{tag_name:"v99.0.0"},{tag_name:service+"-v90.0.0",draft:true},{tag_name:service+"-v89.0.0",prerelease:true},{tag_name:service+"-v99.0.0-rc.1"},{tag_name:service+"-v01.2.0"},{tag_name:service+"-v1.0.10"}];
 const fetchImpl=async()=>new Response(JSON.stringify(releases),{headers:{"Content-Type":"application/json"}});
 const original=globalThis.fetch;globalThis.fetch=fetchImpl;t.after(()=>globalThis.fetch=original);
 const result=await checkGithubRelease("https://github.com/example/laboratory", "1.0.9");
 assert.equal(result.available_version,"1.0.10");assert.equal(result.update_available,true);
});
