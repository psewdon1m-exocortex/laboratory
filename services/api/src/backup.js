import crypto from "node:crypto";
import { strFromU8, unzipSync, zipSync } from "fflate";

const MANIFEST_NAME = "manifest.json";
const DATA_NAME = "laboratory-backup.json";
export const MAX_ARCHIVE_BYTES = 128 * 1024 * 1024;
const MAX_EXPANDED_BYTES = 512 * 1024 * 1024;
const MAX_MEMBER_BYTES = 128 * 1024 * 1024;
const MAX_ENTRIES = 10_000;
const MAX_COMPRESSION_RATIO = 120;

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function safeMemberName(name) {
  return Boolean(name)
    && !name.startsWith("/")
    && !name.includes("\\")
    && !name.split("/").some((part) => !part || part === "." || part === "..");
}

function backupRecordCounts(snapshot) {
  const library = snapshot.library || {};
  const notifications = snapshot.notifications || {};
  return {
    settings: snapshot.settings?.length || 0,
    assets: snapshot.assets?.length || 0,
    contentEvents: snapshot.contentEvents?.length || 0,
    articles: library.articles?.length || snapshot.articles?.length || 0,
    revisions: library.revisions?.length || 0,
    files: library.files?.length || 0,
    aliases: library.aliases?.length || 0,
    goneUrls: library.goneUrls?.length || 0,
    sync: library.sync?.length || 0,
    derivatives: library.derivatives?.length || 0,
    derivativeGenerations: library.derivativeGenerations?.length || 0,
    generationJobs: library.generationJobs?.length || 0,
    githubImportJobs: library.githubImportJobs?.length || 0,
    searchNotificationJobs: notifications.jobs?.length || 0,
    searchNotificationState: notifications.state?.length || 0,
    searchNotificationUrlJobs: notifications.urlJobs?.length || 0,
  };
}

function findEndOfCentralDirectory(buffer) {
  const minimum = Math.max(0, buffer.length - 65_557);
  for (let offset = buffer.length - 22; offset >= minimum; offset -= 1) {
    if (buffer.readUInt32LE(offset) === 0x06054b50) return offset;
  }
  throw new Error("Backup archive has no valid ZIP directory");
}

function inspectZip(buffer) {
  if (!buffer?.length || buffer.length > MAX_ARCHIVE_BYTES) throw new Error("Backup archive is empty or exceeds 128 MiB");
  const eocd = findEndOfCentralDirectory(buffer);
  const disk = buffer.readUInt16LE(eocd + 4);
  const centralDisk = buffer.readUInt16LE(eocd + 6);
  const diskEntries = buffer.readUInt16LE(eocd + 8);
  const totalEntries = buffer.readUInt16LE(eocd + 10);
  const centralSize = buffer.readUInt32LE(eocd + 12);
  const centralOffset = buffer.readUInt32LE(eocd + 16);
  const commentLength = buffer.readUInt16LE(eocd + 20);
  if (disk || centralDisk || diskEntries !== totalEntries || totalEntries === 0xffff
    || centralSize === 0xffffffff || centralOffset === 0xffffffff) {
    throw new Error("Multi-disk and ZIP64 backups are not supported");
  }
  if (eocd + 22 + commentLength !== buffer.length || totalEntries > MAX_ENTRIES
    || centralOffset + centralSize !== eocd) {
    throw new Error("Backup ZIP directory is invalid or exceeds the member limit");
  }
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const entries = [];
  const names = new Set();
  let expandedBytes = 0;
  let offset = centralOffset;
  for (let index = 0; index < totalEntries; index += 1) {
    if (offset + 46 > eocd || buffer.readUInt32LE(offset) !== 0x02014b50) throw new Error("Backup ZIP directory entry is invalid");
    const flags = buffer.readUInt16LE(offset + 8);
    const method = buffer.readUInt16LE(offset + 10);
    const compressedSize = buffer.readUInt32LE(offset + 20);
    const expandedSize = buffer.readUInt32LE(offset + 24);
    const nameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const entryCommentLength = buffer.readUInt16LE(offset + 32);
    const next = offset + 46 + nameLength + extraLength + entryCommentLength;
    if (next > eocd || flags & 0x1 || ![0, 8].includes(method)
      || compressedSize === 0xffffffff || expandedSize === 0xffffffff) {
      throw new Error("Backup contains an unsupported ZIP member");
    }
    let name;
    try { name = decoder.decode(buffer.subarray(offset + 46, offset + 46 + nameLength)); }
    catch { throw new Error("Backup contains a non-UTF-8 member name"); }
    if (!safeMemberName(name) || names.has(name) || expandedSize > MAX_MEMBER_BYTES) {
      throw new Error("Backup contains an unsafe, duplicate or oversized member");
    }
    if (expandedSize > 1024 * 1024 && expandedSize / Math.max(1, compressedSize) > MAX_COMPRESSION_RATIO) {
      throw new Error("Backup member compression ratio is unsafe");
    }
    expandedBytes += expandedSize;
    if (expandedBytes > MAX_EXPANDED_BYTES) throw new Error("Backup expanded size exceeds 512 MiB");
    names.add(name);
    entries.push({ name, compressedSize, expandedSize });
    offset = next;
  }
  if (offset !== centralOffset + centralSize) throw new Error("Backup ZIP directory size is inconsistent");
  return entries;
}

export async function createBackup(store, version) {
  const snapshot = store.exportSnapshot();
  const data = Buffer.from(JSON.stringify(snapshot, null, 2));
  const files = await store.backupFiles(snapshot);
  const members = [{ name: DATA_NAME, size: data.length, sha256: sha256(data), records: backupRecordCounts(snapshot) }];
  for (const [name, value] of Object.entries(files).sort(([left], [right]) => left.localeCompare(right))) {
    if (!safeMemberName(name)) throw new Error(`Unsafe backup member: ${name}`);
    const bytes = Buffer.from(value);
    members.push({ name, size: bytes.length, sha256: sha256(bytes) });
  }
  if (members.length + 1 > MAX_ENTRIES) throw new Error("Laboratory backup contains too many members");
  const manifest = Buffer.from(JSON.stringify({
    schema: "exocortex.laboratory.backup-manifest.v2",
    component: "laboratory",
    version,
    createdAt: new Date().toISOString(),
    data: DATA_NAME,
    members,
  }, null, 2));
  const payload = { [MANIFEST_NAME]: new Uint8Array(manifest), [DATA_NAME]: new Uint8Array(data), ...files };
  const archive = Buffer.from(zipSync(payload, { level: 6 }));
  if (archive.length > MAX_ARCHIVE_BYTES) throw new Error("Laboratory backup exceeds the updater 128 MiB limit");
  inspectZip(archive);
  return archive;
}

export function parseBackup(buffer) {
  const archive = Buffer.from(buffer || []);
  const centralEntries = inspectZip(archive);
  const entries = unzipSync(new Uint8Array(archive));
  const names = Object.keys(entries);
  if (names.length !== centralEntries.length || !entries[MANIFEST_NAME] || !entries[DATA_NAME]) {
    throw new Error("Backup archive is incomplete");
  }
  const manifest = JSON.parse(strFromU8(entries[MANIFEST_NAME]));
  if (manifest.schema === "exocortex.laboratory.backup-manifest.v1") {
    if (manifest.data !== DATA_NAME) throw new Error("Unsupported Laboratory backup manifest");
  } else if (manifest.schema === "exocortex.laboratory.backup-manifest.v2") {
    if (manifest.component !== "laboratory" || manifest.data !== DATA_NAME || !Array.isArray(manifest.members)) {
      throw new Error("Unsupported Laboratory backup manifest");
    }
    const expected = new Map();
    for (const member of manifest.members) {
      if (!safeMemberName(member?.name) || expected.has(member.name)
        || !Number.isSafeInteger(member.size) || member.size < 0
        || !/^[a-f0-9]{64}$/.test(member.sha256 || "")) {
        throw new Error("Backup manifest member is invalid");
      }
      expected.set(member.name, member);
    }
    const actualNames = names.filter((name) => name !== MANIFEST_NAME);
    if (expected.size !== actualNames.length || actualNames.some((name) => !expected.has(name))) {
      throw new Error("Backup members do not match the manifest");
    }
    for (const name of actualNames) {
      const bytes = Buffer.from(entries[name]);
      const member = expected.get(name);
      if (bytes.length !== member.size || sha256(bytes) !== member.sha256) {
        throw new Error(`Backup member checksum mismatch: ${name}`);
      }
    }
  } else {
    throw new Error("Unsupported Laboratory backup manifest");
  }
  const snapshot = JSON.parse(strFromU8(entries[DATA_NAME]));
  const files = {};
  for (const [name, value] of Object.entries(entries)) {
    if (name !== MANIFEST_NAME && name !== DATA_NAME) files[name] = Buffer.from(value);
  }
  return { manifest, snapshot, files };
}
