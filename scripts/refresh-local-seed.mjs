import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const databasePath = path.join(root, "data", "runtime", "laboratory.sqlite");
const defaultsDir = path.join(root, "data", "defaults");
const articlesDir = path.join(root, "data", "runtime", "uploads", "articles");
const files = ["study-one.pdf", "study-two.pdf", "study-three.pdf"];

const database = new DatabaseSync(databasePath);
const update = database.prepare("UPDATE articles SET pdf_size = ?, pdf_sha256 = ?, updated_at = ? WHERE pdf_filename = ?");
for (const filename of files) {
  const source = path.join(defaultsDir, filename);
  const destination = path.join(articlesDir, filename);
  await fs.copyFile(source, destination);
  const data = await fs.readFile(source);
  const digest = crypto.createHash("sha256").update(data).digest("hex");
  update.run(data.length, digest, new Date().toISOString(), filename);
}
database.close();
console.log("Local article seed refreshed.");
