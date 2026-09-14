import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

const filename = (config) => path.join(config.dataDir, "kernel-connection.enc.json");
const key = (config) => crypto.createHash("sha256").update("laboratory/kernel-connection/v1\0" + config.sessionSecret).digest();
export async function loadKernelConnection(config) {
  let text;
  try { text = await fs.readFile(filename(config), "utf8"); } catch (error) { if (error.code === "ENOENT") return; throw error; }
  const item = JSON.parse(text);
  if (item.schema !== 1) throw new Error("Unsupported saved Kernel connection");
  const decrypt = crypto.createDecipheriv("aes-256-gcm", key(config), Buffer.from(item.iv, "base64"));
  decrypt.setAAD(Buffer.from("laboratory/kernel-connection/v1"));
  decrypt.setAuthTag(Buffer.from(item.tag, "base64"));
  const value = JSON.parse(Buffer.concat([decrypt.update(Buffer.from(item.data, "base64")), decrypt.final()]).toString("utf8"));
  Object.assign(config, { kernelUrl: value.url, kernelServiceToken: value.token });
}
export async function saveKernelConnection(config, url, token) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key(config), iv);
  cipher.setAAD(Buffer.from("laboratory/kernel-connection/v1"));
  const data = Buffer.concat([cipher.update(JSON.stringify({ url, token })), cipher.final()]);
  const file = filename(config), temporary = file + "." + crypto.randomUUID() + ".tmp";
  await fs.mkdir(config.dataDir, { recursive: true });
  try {
    await fs.writeFile(temporary, JSON.stringify({ schema: 1, iv: iv.toString("base64"), tag: cipher.getAuthTag().toString("base64"), data: data.toString("base64") }), { mode: 0o600, flag: "wx" });
    await fs.rename(temporary, file);
  } finally { await fs.rm(temporary, { force: true }); }
}
