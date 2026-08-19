import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

const laboratoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const workspaceRoot = path.resolve(laboratoryRoot, "..");
const openNodeRoot = path.join(workspaceRoot, "kernel", "vendor", "open-node");
const esbuildModule = path.join(openNodeRoot, "node_modules", "esbuild", "lib", "main.js");
const { build } = await import(pathToFileURL(esbuildModule));

await build({
  entryPoints: [path.join(laboratoryRoot, "services", "web", "open-node-entry.ts")],
  bundle: true,
  format: "esm",
  minify: true,
  outfile: path.join(laboratoryRoot, "services", "web", "static", "vendor", "open-node-viewer.js"),
  logLevel: "info",
});

const vendorDir = path.join(laboratoryRoot, "services", "web", "static", "vendor");
const digest = (name) => `sha256:${crypto.createHash("sha256").update(fs.readFileSync(path.join(vendorDir, name))).digest("hex")}`;
const sourceCommit = execFileSync("git", ["-C", path.join(workspaceRoot, "kernel"), "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
fs.writeFileSync(path.join(vendorDir, "open-node-viewer.manifest.json"), `${JSON.stringify({
  schema: "laboratory.vendored-asset.v1",
  name: "open-node-viewer",
  version: "0.1.0",
  source: {
    repository: "https://github.com/psewdon1m-exocortex/kernel.git",
    commit: sourceCommit,
    path: "vendor/open-node",
  },
  files: {
    "open-node-viewer.js": digest("open-node-viewer.js"),
    "open-node-viewer.css": digest("open-node-viewer.css"),
  },
}, null, 2)}\n`);
