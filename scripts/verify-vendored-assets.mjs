import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const directory = path.join(root, "services", "web", "static", "vendor");
const manifest = JSON.parse(fs.readFileSync(path.join(directory, "open-node-viewer.manifest.json"), "utf8"));
if (manifest.schema !== "laboratory.vendored-asset.v1"
  || !/^[a-f0-9]{40}$/.test(manifest.source?.commit || "")
  || manifest.source?.repository !== "https://github.com/psewdon1m-exocortex/kernel.git") {
  throw new Error("Open Node vendor provenance is invalid");
}
for (const [name, expected] of Object.entries(manifest.files || {})) {
  const actual = `sha256:${crypto.createHash("sha256").update(fs.readFileSync(path.join(directory, name))).digest("hex")}`;
  if (actual !== expected) throw new Error(`${name} does not match its vendored provenance manifest`);
}
console.log(`verified ${manifest.name} ${manifest.version} from ${manifest.source.commit}`);
