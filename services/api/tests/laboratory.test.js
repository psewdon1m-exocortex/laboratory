import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { strToU8, unzipSync, zipSync } from "fflate";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { NodeRegistry } from "../../../../kernel/vendor/open-node/packages/sdk/dist/index.js";

import { ARTICLE_ID_PATTERN, parseArticleArchive } from "../src/article-archive.js";
import { AuditLog } from "../src/audit-log.js";
import { createSession, credentialsMatch, readSession } from "../src/auth.js";
import { createBackup, parseBackup } from "../src/backup.js";
import { loadConfig } from "../src/config.js";
import { DerivedContentRuntime, verifyEvidence } from "../src/derived-content.js";
import { applyLaboratoryRegister, verifySnapshot } from "../src/kernel-register.js";
import { createLaboratoryApp } from "../src/server.js";
import { evidenceTextHash, renderArticlePage } from "../src/seo.js";
import { SearchNotificationRuntime } from "../src/search-notifications.js";
import { LaboratoryStore, validateUpload } from "../src/storage.js";
import { UpdaterClient } from "../src/updater.js";
import { GitHubArticleLibrary, articleLocation, repositoryCoordinates } from "../src/github-library.js";
import { placeholderNodeDefinitions } from "../../web/open-node-placeholders.js";

const defaultsDir = fileURLToPath(new URL("../../../data/defaults/", import.meta.url));

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function snapshot(values) {
  const checksum = crypto.createHash("sha256").update(canonical({ values })).digest("hex");
  return {
    schema: "exocortex.register.snapshot.v1",
    revision: "register-20260817-test",
    checksum: `sha256:${checksum}`,
    values,
  };
}

function articleZip(markdown, extra = {}, id = "") {
  return Buffer.from(zipSync({
    "article.md": strToU8(markdown),
    ...(id ? { "_id.txt": strToU8(`${id}\n`) } : {}),
    ...extra,
  }, { level: 6 }));
}

test("Laboratory resolves custom Open Node types as decorative read-only nodes", () => {
  const project = {
    nodes: [{
      id: "node-observation",
      nodeTypeId: "laboratory.note.observation",
      nodeTypeVersion: "1.0.0",
      label: "Observation",
      color: "#ca5f2b",
      parameters: { note: "Collect source material" },
      ports: [{ id: "idea", label: "Idea", direction: "output", kind: "data", typeId: "core.string", dynamic: true }],
    }],
  };
  const registry = new NodeRegistry();
  for (const definition of placeholderNodeDefinitions(project)) registry.register(definition);
  const resolved = registry.migrate(project.nodes[0]);
  assert.equal(resolved.unresolved, undefined);
  assert.equal(registry.get("laboratory.note.observation", "1.0.0").outputs[0].id, "idea");
});

test("audit log is structured, pseudonymizes network data and never records request bodies", async (context) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "laboratory-audit-"));
  context.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  const audit = new AuditLog({ dataDir, sessionSecret: "test-session-secret-that-is-at-least-thirty-two-characters" });
  await audit.initialize();
  await audit.write({
    requestId: "request-1",
    actor: "operator",
    remoteAddress: "192.0.2.10",
    action: "POST /api/admin/articles",
    outcome: "success",
    status: 201,
    body: { password: "must-not-appear" },
  });
  const exported = await audit.exportJsonl();
  assert.doesNotMatch(exported, /192\.0\.2\.10|must-not-appear|password/);
  const [event] = await audit.list();
  assert.equal(event.schema, "exocortex.laboratory.audit.v1");
  assert.equal(event.action, "POST /api/admin/articles");
  assert.match(event.remoteHash, /^[a-f0-9]{16}$/);
});

test("updater request matches the registered-head v1 contract", async () => {
  const client = new UpdaterClient({
    updaterSocketPath: "/run/exocortex/updater.sock",
    updaterControlToken: "test-updater-control-token",
    updaterHeadId: "laboratory",
  });
  let captured;
  client.request = async (method, route, body, authenticated, timeout) => {
    captured = { method, route, body, authenticated, timeout };
    return { id: "test-job", state: "REQUESTED" };
  };
  const backup = Buffer.from("opaque-valid-backup");
  await client.createUpdate("0.1.0", "laboratory-backup.zip", backup);
  assert.equal(captured.method, "POST");
  assert.equal(captured.route, "/v1/updates");
  assert.equal(captured.authenticated, true);
  assert.equal(captured.body.head_id, "laboratory");
  assert.equal(captured.body.service, "laboratory");
  assert.equal(captured.body.version, "0.1.0");
  assert.equal(captured.body.backup.filename, "laboratory-backup.zip");
  assert.equal(captured.body.backup.data_base64, backup.toString("base64"));
  assert.equal(captured.body.backup.sha256, crypto.createHash("sha256").update(backup).digest("hex"));
  assert.equal(captured.body.backup.restore_url, "/api/internal/updater/restore");
});

test("sessions are signed, scoped and reject tampering", () => {
  const secret = "test-session-secret-that-is-long-enough";
  const session = createSession("operator", secret);
  assert.equal(readSession(session.token, "operator", secret)?.csrf, session.csrf);
  assert.equal(readSession(session.token, "another-user", secret), null);
  assert.equal(readSession(`${session.token}x`, "operator", secret), null);
  assert.equal(credentialsMatch("operator", "correct horse battery staple", {
    adminUsername: "operator",
    adminPassword: "correct horse battery staple",
  }), true);
});

test("Kernel Register resolves Laboratory repository and public URL", () => {
  const values = {
    repositories: { laboratory: {
      url: "https://github.com/psewdon1m-exocortex/laboratory",
      content: { url: "https://github.com/psewdon1m-exocortex/laboratory-library", branch: "main" },
    } },
    services: { laboratory: { sni: "laboratory.example.com", port: "443", ai: { gemini_api_key: "test-open-gemini-key" } } },
    intervals: { kernel: { refresh_sec: "75" } },
  };
  const verified = verifySnapshot(snapshot(values));
  const resolved = applyLaboratoryRegister({
    repositoryUrl: "",
    contentRepositoryUrl: "",
    contentRepositoryBranch: "main",
    publicUrl: "",
    kernelRefreshSeconds: 60,
  }, verified);
  assert.equal(resolved.repositoryUrl, "https://github.com/psewdon1m-exocortex/laboratory");
  assert.equal(resolved.contentRepositoryUrl, "https://github.com/psewdon1m-exocortex/laboratory-library");
  assert.equal(resolved.contentRepositoryBranch, "main");
  assert.equal(resolved.publicUrl, "https://laboratory.example.com");
  assert.equal(resolved.geminiApiKey, "test-open-gemini-key");
  assert.equal(resolved.refreshSeconds, 75);
  const localOnly = applyLaboratoryRegister({
    repositoryUrl: "",
    contentRepositoryUrl: "https://github.com/should-not/be-used",
    contentRepositoryBranch: "fallback",
    publicUrl: "",
    kernelRefreshSeconds: 60,
  }, null);
  assert.equal(localOnly.contentRepositoryUrl, "");
  assert.equal(localOnly.contentRepositoryBranch, "");
  assert.throws(() => verifySnapshot({ ...verified, checksum: "sha256:invalid" }), /checksum mismatch/);
});

test("AI pipeline is controlled by a strict 0/1 environment switch", () => {
  const previous = process.env.LABORATORY_AI_PIPELINE_ENABLED;
  try {
    process.env.LABORATORY_AI_PIPELINE_ENABLED = "0";
    assert.equal(loadConfig().derivedContentEnabled, false);
    process.env.LABORATORY_AI_PIPELINE_ENABLED = "1";
    assert.equal(loadConfig().derivedContentEnabled, true);
    process.env.LABORATORY_AI_PIPELINE_ENABLED = "true";
    assert.throws(() => loadConfig(), /must be 0 or 1/);
  } finally {
    if (previous == null) delete process.env.LABORATORY_AI_PIPELINE_ENABLED;
    else process.env.LABORATORY_AI_PIPELINE_ENABLED = previous;
  }
});

test("local Gemini key file overrides Registry only outside production", async (context) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "laboratory-gemini-key-"));
  const keyFile = path.join(directory, "gemini-api-key.txt");
  context.after(() => fs.rm(directory, { recursive: true, force: true }));
  await fs.writeFile(keyFile, "local-test-gemini-key-123456\n", { mode: 0o600 });
  const library = { db: {} };
  const register = { state: { geminiApiKey: "registry-test-gemini-key-654321" } };
  const development = new DerivedContentRuntime({ environment: "development", geminiApiKeyFile: keyFile }, library, register);
  assert.deepEqual(development.credential(), {
    key: "local-test-gemini-key-123456",
    source: "local-file",
    error: "",
  });
  await fs.writeFile(keyFile, "PASTE_GEMINI_API_KEY_HERE\n", { mode: 0o600 });
  assert.equal(development.credential().source, "kernel-register");
  assert.equal(development.apiKey(), "registry-test-gemini-key-654321");
  await fs.writeFile(keyFile, "local-test-gemini-key-123456\n", { mode: 0o600 });
  const production = new DerivedContentRuntime({ environment: "production", geminiApiKeyFile: keyFile }, library, register);
  assert.equal(production.credential().source, "kernel-register");
  assert.equal(production.apiKey(), "registry-test-gemini-key-654321");
});

test("SQLite content model seeds English pages and searchable articles", async (context) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "laboratory-store-"));
  const store = await LaboratoryStore.open({ dataDir, defaultsDir });
  context.after(async () => {
    store.close();
    await fs.rm(dataDir, { recursive: true, force: true });
  });

  const content = store.getContent();
  assert.equal(content.pages.about.title, "about me");
  assert.equal(content.pages.journal.title, "journal");
  assert.match(content.publicAssets.aboutMarkdown, /\/api\/media\/aboutMarkdown\//);
  assert.match((await store.readAsset("aboutMarkdown")).data.toString("utf8"), /Mara Ellison/);
  assert.deepEqual(
    store.listArticles({ sort: "newest" }).map((article) => article.slug),
    ["shape-of-a-working-idea", "notes-on-reversible-systems", "small-atlas-of-attention"],
  );
  assert.deepEqual(
    store.listArticles({ query: "atlas" }).map((article) => article.slug),
    ["small-atlas-of-attention"],
  );
  assert.equal(validateUpload("aboutPdf", {
    buffer: Buffer.from("%PDF-1.7\n"),
  }).mime, "application/pdf");
  assert.throws(() => validateUpload("aboutPdf", { buffer: Buffer.from("not a pdf") }), /not a PDF/);
  assert.equal(validateUpload("aboutMarkdown", {
    buffer: Buffer.from("# Profile\n", "utf8"),
  }).mime, "text/markdown");
  assert.throws(() => validateUpload("aboutMarkdown", { buffer: Buffer.from([0xff, 0xfe]) }), /UTF-8 Markdown/);

  const backup = parseBackup(await createBackup(store, "0.1.0-test"));
  assert.equal(backup.snapshot.schema, "exocortex.laboratory.backup.v3");
  assert.equal(backup.manifest.schema, "exocortex.laboratory.backup-manifest.v2");
  assert.equal(backup.manifest.members.find((member) => member.name === "laboratory-backup.json").records.articles, 3);
  assert.ok(Object.keys(backup.files).some((name) => name.startsWith("assets/aboutMarkdown/")));
  assert.ok(Object.keys(backup.files).some((name) => name.startsWith("library/") && backup.files[name].length > 1000));
});

test("backup preflight rejects corruption, traversal and compression bombs", async (context) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "laboratory-backup-safety-"));
  const store = await LaboratoryStore.open({ dataDir, defaultsDir });
  context.after(async () => {
    store.close();
    await fs.rm(dataDir, { recursive: true, force: true });
  });
  const archive = await createBackup(store, "0.1.0-test");
  const entries = unzipSync(new Uint8Array(archive));
  const memberName = Object.keys(entries).find((name) => name.startsWith("assets/"));
  entries[memberName] = Uint8Array.from(entries[memberName], (value, index) => index === 0 ? value ^ 0xff : value);
  assert.throws(() => parseBackup(Buffer.from(zipSync(entries))), /checksum mismatch/);

  const traversal = Buffer.from(zipSync({
    "manifest.json": strToU8("{}"),
    "laboratory-backup.json": strToU8("{}"),
    "../escape.txt": strToU8("unsafe"),
  }));
  assert.throws(() => parseBackup(traversal), /unsafe|duplicate|oversized/);

  const bomb = Buffer.from(zipSync({
    "manifest.json": strToU8("{}"),
    "laboratory-backup.json": strToU8("{}"),
    "large-zeroes.bin": new Uint8Array(2 * 1024 * 1024),
  }, { level: 9 }));
  assert.throws(() => parseBackup(bomb), /compression ratio/);
});

test("failed restore rolls back database and files, while clean restore removes orphans", async (context) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "laboratory-restore-atomic-"));
  const store = await LaboratoryStore.open({ dataDir, defaultsDir });
  context.after(async () => {
    store.close();
    await fs.rm(dataDir, { recursive: true, force: true });
  });
  const parsed = parseBackup(await createBackup(store, "0.1.0-test"));
  const changed = store.getContent();
  changed.siteTitle = "Current state survives";
  store.updateContent(changed);
  const orphan = path.join(store.uploadsDir, "library", "orphan.bin");
  await fs.writeFile(orphan, "orphan");

  const invalid = structuredClone(parsed.snapshot);
  invalid.settings = [
    { key: "siteTitle", value: "bad-one" },
    { key: "siteTitle", value: "bad-two" },
  ];
  await assert.rejects(() => store.restoreSnapshot(invalid, parsed.files), /UNIQUE constraint/);
  assert.equal(store.getContent().siteTitle, "Current state survives");
  assert.equal(await fs.readFile(orphan, "utf8"), "orphan");

  const restored = await store.restoreSnapshot(parsed.snapshot, parsed.files);
  assert.equal(restored.articles, 3);
  assert.equal(store.getContent().siteTitle, "Laboratory");
  await assert.rejects(() => fs.stat(orphan), /ENOENT/);
  const checkpoint = await store.saveRestorePoint(await createBackup(store, "0.1.0-test"));
  assert.match(path.basename(checkpoint), /^before-restore-\d{14}-[a-f0-9]{6}\.zip$/);
});

test("ZIP publication assigns stable IDs, renders directives and hides unpublished revisions", async (context) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "laboratory-library-"));
  const store = await LaboratoryStore.open({ dataDir, defaultsDir });
  context.after(async () => {
    store.close();
    await fs.rm(dataDir, { recursive: true, force: true });
  });
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]);
  const archive = articleZip([
    "# A rendered note",
    "",
    "<script>alert('no')</script>",
    "",
    "::gallery{pixel.png}",
    "",
    "::file{data.csv}",
  ].join("\n"), {
    "metadata.json": strToU8(JSON.stringify({
      schema: "article.metadata.v1",
      description: "A compact archive-level description.",
      sources: [{ title: "Primary source", url: "https://example.com/source" }],
    })),
    "media/pixel.png": png,
    "media/pixel-copy.png": png,
    "attachments/data.csv": strToU8("a,b\n1,2\n"),
  });
  const parsed = parseArticleArchive(archive, { archiveName: "A Rendered Note.zip", status: "published" });
  assert.equal(parsed.internalId, null);
  assert.equal(parsed.metadata.description, "A compact archive-level description.");
  assert.equal(parseArticleArchive(archive, { archiveName: "A Rendered Note.zip" }).status, "published");
  const first = await store.library.importArchive(parsed, { now: "2026-07-24T12:00:00.000Z" });
  assert.match(first.article.internalId, ARTICLE_ID_PATTERN);
  assert.equal(first.assignedId, true);
  const publicArticle = store.getArticle(first.article.slug);
  assert.match(publicArticle.bodyHtml, /article-gallery/);
  assert.equal(publicArticle.metadata.sources[0].url, "https://example.com/source");
  assert.match(publicArticle.bodyHtml, /<h1 id="a-rendered-note">/);
  assert.match(publicArticle.bodyHtml, /attachments%2F|attachments\//);
  assert.doesNotMatch(publicArticle.bodyHtml, /<script/i);
  assert.equal(publicArticle.revisedAt, null);
  const normalized = parseArticleArchive(first.archive, { archiveName: "A Rendered Note.zip", status: "published" });
  assert.equal(normalized.internalId, first.article.internalId);
  assert.equal(normalized.metadata.description, "A compact archive-level description.");
  assert.throws(() => parseArticleArchive(articleZip("# Invalid", {
    "metadata.json": strToU8(JSON.stringify({ authors: ["Not allowed here"] })),
  }), { archiveName: "Invalid Metadata.zip" }), /unsupported fields/);

  const unpublished = await store.library.revise(first.article.internalId, {
    title: "A Rendered Note, Expanded",
    status: "unpublished",
    markdownSource: "# Unpublished text",
  });
  assert.equal(unpublished.article.revision, 2);
  assert.equal(unpublished.article.status, "unpublished");
  assert.equal(store.getArticle(first.article.slug), null);
  const published = await store.library.revise(first.article.internalId, { status: "published" });
  assert.equal(published.article.revision, 3);
  assert.equal(store.getArticle(first.article.slug).title, "A Rendered Note, Expanded");
  assert.ok(store.getArticle(first.article.slug).revisedAt);
  const moved = await store.library.revise(first.article.internalId, { slug: "rendered-note-stable-url" });
  assert.equal(moved.article.slug, "rendered-note-stable-url");
  assert.equal(store.getArticle(first.article.slug).slug, "rendered-note-stable-url");
});

test("GitHub library accepts only the registered repository and signed payloads", () => {
  assert.deepEqual(repositoryCoordinates("https://github.com/psewdon1m-exocortex/laboratory-library.git"), {
    owner: "psewdon1m-exocortex",
    repository: "laboratory-library",
    fullName: "psewdon1m-exocortex/laboratory-library",
    url: "https://github.com/psewdon1m-exocortex/laboratory-library",
  });
  assert.deepEqual(articleLocation("published/My Study.zip"), { path: "published/My Study.zip", status: "published", archiveName: "My Study.zip" });
  assert.deepEqual(articleLocation("unpublished/My Study.zip"), { path: "unpublished/My Study.zip", status: "unpublished", archiveName: "My Study.zip" });
  assert.equal(articleLocation("misc/My Study.zip"), null);
  const raw = Buffer.from('{"zen":"safe"}');
  const secret = "github-webhook-secret";
  const signature = `sha256=${crypto.createHmac("sha256", secret).update(raw).digest("hex")}`;
  const github = new GitHubArticleLibrary({ githubWebhookSecret: secret }, { state: {} }, { getSyncState: () => ({}) });
  assert.equal(github.verifyWebhook(signature, raw), true);
  assert.throws(() => github.verifyWebhook("sha256=wrong", raw), /Invalid GitHub webhook signature/);
});

test("GitHub push deletions remove repository-backed articles", async (context) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "laboratory-github-delete-"));
  const store = await LaboratoryStore.open({ dataDir, defaultsDir });
  context.after(async () => {
    store.close();
    await fs.rm(dataDir, { recursive: true, force: true });
  });
  const sourcePath = "published/Delete Through Git.zip";
  const imported = await store.library.importArchive(articleZip("# Removed through Git"), {
    archiveName: "Delete Through Git.zip",
    status: "published",
    sourceKind: "github",
    sourcePath,
  });
  const github = new GitHubArticleLibrary(
    { githubToken: "", githubWebhookSecret: "", version: "test" },
    { state: { contentRepositoryUrl: "https://github.com/psewdon1m-exocortex/laboratory-library", contentRepositoryBranch: "main" } },
    store.library,
  );
  const result = await github.handlePush({
    repository: { full_name: "psewdon1m-exocortex/laboratory-library" },
    after: "abc123",
    commits: [{ added: [], modified: [], removed: [sourcePath] }],
  });
  assert.equal(result.deleted.length, 1);
  assert.equal(result.deleted[0].internalId, imported.article.internalId);
  assert.equal(store.library.getAdminArticle(imported.article.internalId), null);
});

test("v2 backups restore article identities, revisions and files", async (context) => {
  const sourceDir = await fs.mkdtemp(path.join(os.tmpdir(), "laboratory-backup-source-"));
  const restoreDir = await fs.mkdtemp(path.join(os.tmpdir(), "laboratory-backup-restore-"));
  const source = await LaboratoryStore.open({ dataDir: sourceDir, defaultsDir });
  const restore = await LaboratoryStore.open({ dataDir: restoreDir, defaultsDir });
  context.after(async () => {
    source.close();
    restore.close();
    await fs.rm(sourceDir, { recursive: true, force: true });
    await fs.rm(restoreDir, { recursive: true, force: true });
  });
  const publication = await source.library.importArchive(articleZip("# Preserved revision"), {
    archiveName: "Preserved Revision.zip",
    status: "published",
  });
  const backup = parseBackup(await createBackup(source, "0.1.0-test"));
  const restored = await restore.restoreSnapshot(backup.snapshot, backup.files);
  assert.equal(restored.articles, 4);
  const article = restore.getArticle(publication.article.slug);
  assert.equal(article.internalId, publication.article.internalId);
  assert.match(article.bodyHtml, /Preserved revision/);
  assert.equal(restore.library.getAdminArticle(article.internalId).revisions.length, 1);
});

test("derived generations use immutable versioned URLs and requeue stale prompt versions", async (context) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "laboratory-derived-"));
  const store = await LaboratoryStore.open({ dataDir, defaultsDir });
  const runtime = new DerivedContentRuntime({
    derivedContentEnabled: true,
    derivedContentIntervalSeconds: 60,
    derivedContentMaxAttempts: 3,
    geminiModel: "gemini-test-model",
    geminiMaxOutputTokens: 4096,
  }, store.library, { state: { geminiApiKey: "" } });
  context.after(async () => {
    runtime.stop();
    store.close();
    await fs.rm(dataDir, { recursive: true, force: true });
  });
  const imported = await store.library.importArchive(articleZip("# Verified source\n\nThis exact evidence passage is long enough to cite safely."), {
    archiveName: "Derived test.zip",
    status: "published",
  });
  runtime.enqueueMissing();
  const importedRevisionId = store.library.db.prepare("SELECT current_revision_id AS id FROM library_articles WHERE internal_id = ?").get(imported.article.internalId).id;
  store.library.db.prepare("DELETE FROM article_generation_jobs WHERE revision_id <> ?").run(importedRevisionId);
  const job = runtime.nextJob();
  assert.ok(job);
  runtime.ensureAi = () => ({
    models: {
      generateContent: async () => ({
        text: JSON.stringify({
          description: "too short",
          abstractMarkdown: "# Abstract\n\nA valid abstract body that is long enough for local validation.",
          transcriptMarkdown: null,
          evidence: [],
          warnings: [],
        }),
        usageMetadata: { promptTokenCount: 120, candidatesTokenCount: 15, totalTokenCount: 135 },
      }),
    },
  });
  await assert.rejects(runtime.generate(job), /description has an invalid length/);
  assert.deepEqual(JSON.parse(store.library.db.prepare("SELECT usage_json AS usage FROM article_generation_jobs WHERE revision_id = ?").get(job.revision_id).usage), {
    promptTokenCount: 120,
    candidatesTokenCount: 15,
    totalTokenCount: 135,
  });
  await runtime.persist(job, {
    description: "A compact description of the verified source publication.",
    abstractMarkdown: "# Abstract\n\nA compact abstract that remains tied to the immutable source revision.",
    transcriptMarkdown: null,
    evidence: [], warnings: [], usage: null,
    validation: { schema: true, evidenceSourceMatch: true, verifiedEvidence: 0, unsupportedClaims: 0, sourceCoverage: 1 },
  });
  const article = store.getArticle(imported.article.internalId);
  assert.match(article.derivedContent.generationKey, /^g-[a-f0-9]{16}$/);
  assert.match(article.abstractUrl, new RegExp(`/${article.derivedContent.generationKey}/abstract\\.md$`));
  assert.match(article.abstractHtml, /compact abstract/);
  const articleTemplate = await fs.readFile(fileURLToPath(new URL("../../web/static/article.html", import.meta.url)), "utf8");
  const articlePage = renderArticlePage(articleTemplate, {
    content: store.getContent(),
    article,
    baseUrl: "https://laboratory.example.com",
    nonce: "test-nonce",
    authorName: "c31e1b26",
  });
  assert.match(articlePage, /<details class="article-abstract"><summary>Abstract<\/summary>/);
  assert.match(articlePage, /compact abstract/);
  assert.doesNotMatch(articlePage, /<h1[^>]*>Abstract<\/h1>/i);
  assert.equal(store.library.db.prepare("SELECT COUNT(*) AS count FROM article_derivative_generations").get().count, 1);
  const firstGenerationKey = article.derivedContent.generationKey;
  await runtime.persist(job, {
    description: "A second valid description for a regenerated derivative.",
    abstractMarkdown: "# Revised abstract\n\nA new immutable generation must not overwrite the previous artifact.",
    transcriptMarkdown: null,
    evidence: [], warnings: [], usage: null,
    validation: { schema: true, evidenceSourceMatch: true, verifiedEvidence: 0, unsupportedClaims: 0, sourceCoverage: 1 },
  });
  const regenerated = store.getArticle(imported.article.internalId);
  assert.notEqual(regenerated.derivedContent.generationKey, firstGenerationKey);
  const previousArtifact = await store.library.getDerivedFile(imported.article.internalId, regenerated.revision, firstGenerationKey, "abstract.md");
  assert.match(previousArtifact.bytes.toString("utf8"), /compact abstract/);
  assert.equal(store.library.db.prepare("SELECT COUNT(*) AS count FROM article_derivative_generations").get().count, 2);
  const restoreDir = await fs.mkdtemp(path.join(os.tmpdir(), "laboratory-derived-restore-"));
  const restoredStore = await LaboratoryStore.open({ dataDir: restoreDir, defaultsDir });
  try {
    const backup = parseBackup(await createBackup(store, "0.1.0-test"));
    await restoredStore.restoreSnapshot(backup.snapshot, backup.files);
    const restoredArticle = restoredStore.getArticle(imported.article.internalId);
    assert.equal(restoredArticle.derivedContent.generationKey, regenerated.derivedContent.generationKey);
    assert.match(restoredArticle.abstractHtml, /new immutable generation/);
    const restoredPrevious = await restoredStore.library.getDerivedFile(
      imported.article.internalId, restoredArticle.revision, firstGenerationKey, "abstract.md",
    );
    assert.match(restoredPrevious.bytes.toString("utf8"), /compact abstract/);
  } finally {
    restoredStore.close();
    await fs.rm(restoreDir, { recursive: true, force: true });
  }
  store.library.db.prepare("UPDATE article_derivatives SET prompt_version = 'article-derivatives.v1'").run();
  runtime.enqueueMissing();
  assert.equal(store.library.db.prepare("SELECT status FROM article_generation_jobs WHERE revision_id = ?").get(job.revision_id).status, "pending");
});

test("generated evidence is published only after exact source and locator verification", async () => {
  const result = await verifyEvidence({
    description: "A valid description that is not used by this verification test.",
    abstractMarkdown: "# Abstract\n\nA valid abstract that is not used by this verification test.",
    transcriptMarkdown: null,
    evidence: [
      { text: "This exact source passage can be quoted safely.", sourceLocator: "section:source-heading", confidence: 0.99 },
      { text: "This sentence was invented by the model.", sourceLocator: "section:source-heading", confidence: 0.9 },
      { text: "This exact source passage can be quoted safely.", sourceLocator: "section:missing-heading", confidence: 0.8 },
    ],
    warnings: [], usage: null,
  }, {
    format: "markdown",
    markdown_source: "# Source heading\n\nThis exact source passage can be quoted safely.",
  }, { rootDir: "" });
  assert.equal(result.evidence.length, 1);
  assert.equal(result.evidence[0].verification, "exact-source-match");
  assert.match(result.evidence[0].sourceTextHash, /^sha256:/);
  assert.equal(result.validation.unsupportedClaims, 2);
});

test("deleted article URLs are retained as tombstones and queued for IndexNow", async (context) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "laboratory-indexnow-"));
  const store = await LaboratoryStore.open({ dataDir, defaultsDir });
  const notifications = new SearchNotificationRuntime({
    indexNowEnabled: true,
    googleIndexingExperimentEnabled: false,
    searchNotificationIntervalSeconds: 60,
    searchNotificationTimeoutMs: 1000,
  }, store.library, { state: { publicUrl: "" } });
  context.after(async () => {
    notifications.stop();
    store.close();
    await fs.rm(dataDir, { recursive: true, force: true });
  });
  const imported = await store.library.importArchive(articleZip("# Disposable article\n\nThis article will be removed."), {
    archiveName: "Disposable article.zip",
    status: "published",
  });
  await store.library.deleteArticle(imported.article.internalId);
  assert.equal(store.library.getGoneUrl(imported.article.slug).reason, "deleted");
  notifications.start();
  notifications.enqueueUrlChanges();
  const job = notifications.urlJob("indexnow");
  assert.equal(job.slug, imported.article.slug);
  assert.equal(job.status, "pending");
});

test("HTTP routes, clean article URLs and protected admin mutations work", async (context) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "laboratory-api-"));
  const app = await createLaboratoryApp({
    port: 0,
    dataDir,
    defaultsDir,
    derivedContentEnabled: false,
    geminiApiKeyFile: "",
    adminUsername: "operator",
    adminPassword: "test-admin-password",
    sessionSecret: "test-session-secret-that-is-at-least-thirty-two-characters",
    kernelUrl: "",
    kernelServiceToken: "",
    cookieSecure: false,
  });
  const server = await new Promise((resolve) => {
    const instance = app.listen(0, "127.0.0.1", () => resolve(instance));
  });
  const address = server.address();
  const baseUrl = `http://127.0.0.1:${address.port}`;
  context.after(async () => {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    app.locals.laboratory.register.stop();
    app.locals.laboratory.derivedContent.stop();
    app.locals.laboratory.searchNotifications.stop();
    app.locals.laboratory.store.close();
    await fs.rm(dataDir, { recursive: true, force: true });
  });

  assert.equal((await fetch(`${baseUrl}/api/health`)).status, 200);
  const aboutResponse = await fetch(`${baseUrl}/api/about`);
  assert.match(aboutResponse.headers.get("x-robots-tag"), /noindex/);
  const aboutPayload = await aboutResponse.json();
  assert.match(aboutPayload.bodyHtml, /Mara Ellison/);
  assert.equal(aboutPayload.stats, undefined);
  const articlePage = await fetch(`${baseUrl}/journal/shape-of-a-working-idea`);
  assert.equal(articlePage.status, 200);
  const articleHtml = await articlePage.text();
  assert.match(articleHtml, /scripts\/article\.js/);
  assert.match(articleHtml, /<h1 data-article-title>The Shape of a Working Idea<\/h1>/);
  assert.match(articleHtml, /rel="canonical"/);
  assert.match(articleHtml, /application\/ld\+json/);
  assert.match(articleHtml, /property="og:image"/);
  assert.match(articleHtml, /property="og:image:type" content="image\/png"/);
  assert.match(articleHtml, /property="og:image:width" content="1731"/);
  assert.match(articleHtml, /property="og:image:height" content="909"/);
  assert.match(articleHtml, /property="og:locale" content="en"/);
  assert.match(articleHtml, /name="twitter:card" content="summary_large_image"/);
  assert.match(articleHtml, /name="twitter:image"/);
  assert.match(articleHtml, /rel="alternate" type="text\/markdown"/);
  assert.match(articlePage.headers.get("link"), /shape-of-a-working-idea\.md/);
  assert.doesNotMatch(articleHtml, /Generated text version/);
  assert.match(articleHtml, /"author":\{"@type":"Person","identifier":"c31e1b26","name":"c31e1b26","url":"http:\/\/127\.0\.0\.1:\d+\/about"\}/);
  const aboutHtml = await (await fetch(`${baseUrl}/about`)).text();
  assert.match(aboutHtml, /Mara Ellison/);
  assert.match(aboutHtml, /data-about-title>about me<\/h1>/);
  assert.doesNotMatch(aboutHtml, /article count|publication statistics/i);
  assert.match(aboutHtml, /"@type":"Person"/);
  assert.match(aboutHtml, /property="og:url"/);
  const journalHtml = await (await fetch(`${baseUrl}/journal`)).text();
  assert.match(journalHtml, /href="\/journal\/shape-of-a-working-idea"/);
  const robots = await (await fetch(`${baseUrl}/robots.txt`)).text();
  assert.match(robots, /User-agent: OAI-SearchBot|User-agent: \*/);
  assert.match(robots, /Disallow: \/private/);
  assert.match(robots, /Sitemap: .*\/sitemap-index\.xml/);
  const googleExtended = /User-agent: Google-Extended\r?\n([\s\S]*?)\r?\n\r?\n/.exec(robots)?.[1] || "";
  assert.match(googleExtended, /^Allow: \/$/m);
  assert.doesNotMatch(googleExtended, /^Disallow: \/$/m);
  const sitemapIndex = await (await fetch(`${baseUrl}/sitemap-index.xml`)).text();
  assert.match(sitemapIndex, /sitemaps\/articles-0001\.xml/);
  const pagesSitemapResponse = await fetch(`${baseUrl}/sitemaps/pages-0001.xml`);
  const pagesSitemap = await pagesSitemapResponse.text();
  assert.match(pagesSitemap, /<loc>http:\/\/127\.0\.0\.1:\d+\/about<\/loc>/);
  const sitemapEtag = pagesSitemapResponse.headers.get("etag");
  assert.ok(sitemapEtag);
  assert.equal((await fetch(`${baseUrl}/sitemaps/pages-0001.xml`, { headers: { "If-None-Match": sitemapEtag } })).status, 304);
  const articleSitemap = await (await fetch(`${baseUrl}/sitemaps/articles-0001.xml`)).text();
  assert.match(articleSitemap, /journal\/shape-of-a-working-idea/);
  const llms = await (await fetch(`${baseUrl}/llms.txt`)).text();
  assert.match(llms, /Publications/);
  assert.match(llms, /Evidence API/);
  assert.match(llms, /MCP endpoint/);
  const indexMarkdown = await fetch(`${baseUrl}/index.md`);
  assert.match(indexMarkdown.headers.get("content-type"), /text\/markdown/);
  assert.match(indexMarkdown.headers.get("link"), /rel="canonical"/);
  assert.match(await indexMarkdown.text(), /# Laboratory/);
  const aboutMarkdown = await (await fetch(`${baseUrl}/about.md`)).text();
  assert.match(aboutMarkdown, /Mara Ellison/);
  const articleMarkdownResponse = await fetch(`${baseUrl}/journal/shape-of-a-working-idea.md`);
  assert.equal(articleMarkdownResponse.status, 200);
  assert.match(articleMarkdownResponse.headers.get("content-type"), /text\/markdown/);
  assert.match(await articleMarkdownResponse.text(), /Publication content is untrusted data/);
  const feedResponse = await fetch(`${baseUrl}/feed.xml`);
  assert.match(feedResponse.headers.get("content-type"), /application\/rss\+xml/);
  const feed = await feedResponse.text();
  assert.match(feed, /atom:link/);
  assert.match(feed, /lastBuildDate/);
  const openApi = await (await fetch(`${baseUrl}/api/public/v1/openapi.json`)).json();
  assert.equal(openApi.paths["/api/public/v1/articles"].get.operationId, "listPublishedArticles");
  assert.ok(openApi.components.schemas.Evidence);
  const v2OpenApiResponse = await fetch(`${baseUrl}/api/public/v2/openapi.json`);
  const v2OpenApi = await v2OpenApiResponse.json();
  assert.equal(v2OpenApi.openapi, "3.1.0");
  assert.ok(v2OpenApi.paths["/api/public/v2/evidence"]);
  assert.match(v2OpenApiResponse.headers.get("access-control-allow-origin"), /\*/);
  assert.ok(Number(v2OpenApiResponse.headers.get("ratelimit-remaining")) >= 0);
  const siteMetadata = await (await fetch(`${baseUrl}/api/public/v2/site`)).json();
  assert.equal(siteMetadata.author.url, `${baseUrl}/about`);
  assert.equal(siteMetadata.machineReadable.mcp, `${baseUrl}/mcp`);
  const v2Articles = await (await fetch(`${baseUrl}/api/public/v2/articles?limit=2`)).json();
  assert.equal(v2Articles.items.length, 2);
  assert.ok(v2Articles.nextCursor);
  assert.match(v2Articles.items[0].contentUrl, /\.md$/);
  const evidenceStateBefore = app.locals.laboratory.store.db.prepare(
    "SELECT revision_id, index_key, indexed_at FROM public_evidence_revision_state ORDER BY revision_id",
  ).all();
  app.locals.laboratory.evidenceIndex.search({ query: "working", baseUrl });
  const evidenceStateAfter = app.locals.laboratory.store.db.prepare(
    "SELECT revision_id, index_key, indexed_at FROM public_evidence_revision_state ORDER BY revision_id",
  ).all();
  assert.deepEqual(evidenceStateAfter, evidenceStateBefore);
  const searchPlan = app.locals.laboratory.store.db.prepare(
    "EXPLAIN QUERY PLAN SELECT rowid FROM public_evidence_fts WHERE public_evidence_fts MATCH ?",
  ).all("working");
  assert.match(searchPlan.map((step) => step.detail).join(" "), /VIRTUAL TABLE INDEX/);

  const mcpClient = new Client({ name: "laboratory-test-client", version: "1.0.0" });
  const mcpTransport = new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`));
  await mcpClient.connect(mcpTransport);
  try {
    const tools = await mcpClient.listTools();
    assert.deepEqual(tools.tools.map((tool) => tool.name).sort(), ["get_publication", "list_publications", "search_publications"]);
    assert.ok(tools.tools.every((tool) => tool.annotations?.readOnlyHint === true));
    const listed = await mcpClient.callTool({ name: "list_publications", arguments: { limit: 2 } });
    assert.equal(listed.isError, undefined);
    assert.equal(listed.structuredContent.items.length, 2);
    const resources = await mcpClient.listResources();
    assert.ok(resources.resources.some((resource) => resource.uri === "laboratory://catalog"));
    const catalogResource = await mcpClient.readResource({ uri: "laboratory://catalog" });
    assert.match(catalogResource.contents[0].text, /shape-of-a-working-idea/);
  } finally {
    await mcpClient.close();
  }
  const rawIndex = await fetch(`${baseUrl}/index`, { redirect: "manual" });
  assert.equal(rawIndex.status, 308);
  assert.equal(rawIndex.headers.get("location"), "/");
  for (const pathName of ["/article", "/404", "/admin"]) {
    const response = await fetch(`${baseUrl}${pathName}`, { redirect: "manual" });
    assert.equal(response.status, 404);
    assert.match(response.headers.get("x-robots-tag"), /noindex/);
  }
  const seededPdf = await (await fetch(`${baseUrl}/api/articles/shape-of-a-working-idea`)).json();
  const pdfResponse = await fetch(`${baseUrl}${seededPdf.pdfUrl}`);
  assert.match(pdfResponse.headers.get("link"), /\/journal\/shape-of-a-working-idea>; rel="canonical"/);
  const privatePage = await fetch(`${baseUrl}/private`);
  assert.equal(privatePage.status, 200);
  assert.match(privatePage.headers.get("x-robots-tag"), /noindex/);
  assert.equal(privatePage.headers.get("cache-control"), "private, no-store");
  assert.match(await privatePage.text(), /data-confirm-dialog/);
  const adminScript = await (await fetch(`${baseUrl}/scripts/admin.js`)).text();
  assert.doesNotMatch(adminScript, /(?:window\.)?confirm\s*\(/);
  const articleScript = await (await fetch(`${baseUrl}/scripts/article.js`)).text();
  assert.doesNotMatch(articleScript, /Generated text version/);
  assert.match(articleScript, /data-article-abstract/);
  assert.match(articleScript, /laboratory_article_scroll_v1/);
  assert.match(articleScript, /history\.scrollRestoration = "manual"/);
  assert.equal((await fetch(`${baseUrl}/admin`)).status, 404);

  const rejected = await fetch(`${baseUrl}/api/admin/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: "operator", password: "wrong-password" }),
  });
  assert.equal(rejected.status, 401);

  const login = await fetch(`${baseUrl}/api/admin/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: "operator", password: "test-admin-password" }),
  });
  assert.equal(login.status, 200);
  const session = await login.json();
  const cookie = login.headers.get("set-cookie").split(";", 1)[0];

  const aboutUpload = new FormData();
  aboutUpload.append("file", new Blob(["# Uploaded profile\n\nUpdated through the private area."], { type: "text/markdown" }), "about.md");
  const uploadedAbout = await fetch(`${baseUrl}/api/admin/upload/aboutMarkdown`, {
    method: "POST",
    headers: { Cookie: cookie, "X-CSRF-Token": session.csrfToken },
    body: aboutUpload,
  });
  assert.equal(uploadedAbout.status, 200);
  assert.match((await uploadedAbout.json()).publicAssets.aboutMarkdown, /\/api\/media\/aboutMarkdown\//);
  assert.match((await (await fetch(`${baseUrl}/api/about`)).json()).bodyHtml, /Uploaded profile/);

  const withoutCsrf = await fetch(`${baseUrl}/api/admin/content`, {
    method: "PUT",
    headers: { Cookie: cookie, "Content-Type": "application/json" },
    body: JSON.stringify({}),
  });
  assert.equal(withoutCsrf.status, 403);

  const current = await (await fetch(`${baseUrl}/api/content`)).json();
  current.pages.about.title = "field profile";
  current.pages.journal.title = "field journal";
  const updated = await fetch(`${baseUrl}/api/admin/content`, {
    method: "PUT",
    headers: {
      Cookie: cookie,
      "Content-Type": "application/json",
      "X-CSRF-Token": session.csrfToken,
    },
    body: JSON.stringify(current),
  });
  assert.equal(updated.status, 200);
  const updatedContent = await updated.json();
  assert.equal(updatedContent.pages.about.title, "field profile");
  assert.equal(updatedContent.pages.journal.title, "field journal");
  const renderedAbout = await (await fetch(`${baseUrl}/about`)).text();
  assert.match(renderedAbout, /data-about-title>field profile<\/h1>/);

  const archive = new FormData();
  archive.append("status", "published");
  archive.append("file", new Blob([articleZip("# HTTP publication\n\nCreated through the private API.")], { type: "application/zip" }), "HTTP Publication.zip");
  const imported = await fetch(`${baseUrl}/api/admin/articles/import`, {
    method: "POST",
    headers: { Cookie: cookie, "X-CSRF-Token": session.csrfToken },
    body: archive,
  });
  assert.equal(imported.status, 201);
  const importedBody = await imported.json();
  assert.match(importedBody.article.internalId, ARTICLE_ID_PATTERN);
  const published = await (await fetch(`${baseUrl}/api/articles/${importedBody.article.slug}`)).json();
  assert.equal(published.format, "markdown");
  assert.match(published.bodyHtml, /HTTP publication/);
  const publishedPage = await (await fetch(`${baseUrl}/journal/${importedBody.article.slug}`)).text();
  assert.match(publishedPage, /Created through the private API/);
  assert.match(publishedPage, /<h1 id="http-publication">/);
  const evidence = await (await fetch(`${baseUrl}/api/public/v1/evidence?q=created`)).json();
  assert.ok(evidence.items.some((item) => item.articleId === importedBody.article.internalId));
  assert.ok(evidence.items.every((item) => item.verified === true && item.sourceTextHash?.startsWith("sha256:")));
  assert.ok(evidence.items.every((item) => item.sourceTextHash === evidenceTextHash(item.text)));
  const v2Evidence = await (await fetch(`${baseUrl}/api/public/v2/evidence?q=created`)).json();
  assert.equal(v2Evidence.items, undefined);
  assert.ok(v2Evidence.articles.some((article) => article.id === importedBody.article.internalId));
  const machineArticle = await (await fetch(`${baseUrl}/api/public/v1/articles/${importedBody.article.slug}`)).json();
  assert.equal(machineArticle.language, "en");
  assert.ok(machineArticle.evidence.length >= 1);
  const adminDetail = await fetch(`${baseUrl}/api/admin/articles/${importedBody.article.internalId}`, { headers: { Cookie: cookie } });
  assert.equal(adminDetail.status, 200);
  assert.equal((await adminDetail.json()).revisions.length, 1);

  const deleted = await fetch(`${baseUrl}/api/admin/articles/${importedBody.article.internalId}`, {
    method: "DELETE",
    headers: { Cookie: cookie, "X-CSRF-Token": session.csrfToken },
  });
  assert.equal(deleted.status, 200);
  assert.equal((await deleted.json()).deleted.internalId, importedBody.article.internalId);
  assert.equal((await fetch(`${baseUrl}/api/articles/${importedBody.article.slug}`)).status, 404);
  const gonePage = await fetch(`${baseUrl}/journal/${importedBody.article.slug}`);
  assert.equal(gonePage.status, 410);
  assert.match(gonePage.headers.get("x-robots-tag"), /noindex/);
  await new Promise((resolve) => setTimeout(resolve, 20));
  const auditResponse = await fetch(`${baseUrl}/api/admin/audit?limit=50`, { headers: { Cookie: cookie } });
  assert.equal(auditResponse.status, 200);
  const auditEvents = (await auditResponse.json()).events;
  assert.ok(auditEvents.some((event) => event.action === "DELETE /api/admin/articles/:id" || event.action.startsWith("DELETE /api/admin/articles/")));
  assert.ok(auditEvents.every((event) => !JSON.stringify(event).includes("test-admin-password")));
  const auditExport = await fetch(`${baseUrl}/api/admin/audit/export`, { headers: { Cookie: cookie } });
  assert.match(auditExport.headers.get("content-type"), /application\/x-ndjson/);
});
