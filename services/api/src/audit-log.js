import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

const MAX_FILE_BYTES = 5 * 1024 * 1024;
const RETAINED_FILES = 5;

function safeText(value, maximum = 240) {
  return String(value ?? "").replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, maximum);
}

export class AuditLog {
  constructor(config) {
    this.directory = path.join(config.dataDir, "audit");
    this.filename = path.join(this.directory, "audit.jsonl");
    this.ipKey = config.sessionSecret;
    this.queue = Promise.resolve();
  }

  async initialize() {
    await fs.mkdir(this.directory, { recursive: true, mode: 0o700 });
  }

  remoteHash(value) {
    return crypto.createHmac("sha256", this.ipKey).update(String(value || "unknown")).digest("hex").slice(0, 16);
  }

  write(event) {
    const record = {
      schema: "exocortex.laboratory.audit.v1",
      at: new Date().toISOString(),
      requestId: safeText(event.requestId, 80),
      actor: safeText(event.actor || "anonymous", 80),
      remoteHash: this.remoteHash(event.remoteAddress),
      action: safeText(event.action, 180),
      outcome: safeText(event.outcome, 40),
      status: Number(event.status) || 0,
    };
    this.queue = this.queue.then(async () => {
      await this.rotateIfNeeded();
      await fs.appendFile(this.filename, `${JSON.stringify(record)}\n`, { encoding: "utf8", mode: 0o600 });
    }).catch((error) => console.error("audit log write failed", error));
    return this.queue;
  }

  async rotateIfNeeded() {
    let size = 0;
    try { size = (await fs.stat(this.filename)).size; } catch (error) { if (error.code !== "ENOENT") throw error; }
    if (size < MAX_FILE_BYTES) return;
    await fs.rm(`${this.filename}.${RETAINED_FILES}`, { force: true });
    for (let index = RETAINED_FILES - 1; index >= 1; index -= 1) {
      try { await fs.rename(`${this.filename}.${index}`, `${this.filename}.${index + 1}`); }
      catch (error) { if (error.code !== "ENOENT") throw error; }
    }
    await fs.rename(this.filename, `${this.filename}.1`);
  }

  async exportJsonl() {
    await this.queue;
    const chunks = [];
    for (let index = RETAINED_FILES; index >= 1; index -= 1) {
      try { chunks.push(await fs.readFile(`${this.filename}.${index}`, "utf8")); }
      catch (error) { if (error.code !== "ENOENT") throw error; }
    }
    try { chunks.push(await fs.readFile(this.filename, "utf8")); }
    catch (error) { if (error.code !== "ENOENT") throw error; }
    return chunks.join("");
  }

  async list(limit = 200) {
    const lines = (await this.exportJsonl()).trim().split("\n").filter(Boolean).slice(-Math.max(1, Math.min(1000, limit))).reverse();
    return lines.map((line) => JSON.parse(line));
  }
}
