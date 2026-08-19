import path from "node:path";
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
