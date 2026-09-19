import fs from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { loadConfig } from "./config.js";
import { MAX_ARCHIVE_BYTES, parseBackupAsync } from "./backup.js";
import { LaboratoryStore } from "./storage.js";

// Updater stops the application before invoking this entry point in the signed
// candidate image. No HTTP server, integration workers or extra ZIP are started.
export async function restoreArchive(filename, config = loadConfig()) {
  const file = await fs.open(filename, "r");
  let bytes;
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size < 1 || stat.size > MAX_ARCHIVE_BYTES) throw new Error("Invalid backup file size or type");
    bytes = await file.readFile();
  } finally { await file.close(); }
  const parsed = await parseBackupAsync(bytes);
  bytes.fill(0);
  const store = await LaboratoryStore.open(config);
  try { return await store.restoreSnapshot(parsed.snapshot, parsed.files); }
  finally { store.close(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.argv.length !== 4 || process.argv[3] !== "--confirm-replace") {
    process.stderr.write("Usage: restore-cli.js <saved-backup.zip> --confirm-replace\n");
    process.exitCode = 2;
  } else {
    try { process.stdout.write(JSON.stringify({ restored: true, ...await restoreArchive(process.argv[2]) }) + "\n"); }
    catch (error) { process.stderr.write(`Laboratory restore failed: ${error.message}\n`); process.exitCode = 1; }
  }
}
