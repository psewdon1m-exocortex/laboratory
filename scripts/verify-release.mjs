import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const filename = process.argv[2];
if (!filename) throw new Error("release manifest path is required");
const manifest = JSON.parse(fs.readFileSync(filename, "utf8"));
if (manifest.schema_version !== 1 || manifest.service !== "laboratory" || manifest.component_role !== "publication-head") {
  throw new Error("release manifest identity is invalid");
}
if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(manifest.version)) throw new Error("release version is invalid");
if (!/^sha256:[a-f0-9]{64}$/.test(manifest.image?.digest || "") || !String(manifest.image?.reference || "").startsWith("ghcr.io/")) {
  throw new Error("release image is not immutable");
}
if (!/^https:\/\/github\.com\//.test(manifest.compose_bundle?.url || "")
  || !/^[a-f0-9]{64}$/.test(manifest.compose_bundle?.sha256 || "")) {
  throw new Error("compose bundle contract is invalid");
}
if (!/^\d+\.\d+\.\d+/.test(manifest.minimum_updater_version || "")
  || !Number.isInteger(manifest.database_schema) || manifest.database_schema < 1
  || manifest.backup_schema !== "exocortex.laboratory.backup.v3"
  || !Number.isInteger(manifest.compose_contract) || manifest.compose_contract < 1) {
  throw new Error("release compatibility metadata is invalid");
}
const bundle = path.join(path.dirname(filename), `laboratory-${manifest.version}-compose.tar.gz`);
if (!fs.statSync(bundle).isFile()) throw new Error("compose bundle is missing");
const members = execFileSync("tar", ["-tzf", bundle], { encoding: "utf8" })
  .split(/\r?\n/)
  .map((entry) => entry.replace(/^\.\//, ""));
for (const required of ["updater/install.sh", "updater/updater-linux-amd64", "updater/systemd/updater.service"]) {
  if (!members.includes(required)) throw new Error(`compose bundle is missing ${required}`);
}
console.log(`verified Laboratory ${manifest.version} release contract`);
