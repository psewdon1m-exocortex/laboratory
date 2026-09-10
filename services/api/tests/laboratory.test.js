import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { strToU8, unzipSync, zipSync } from "fflate";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";

import { ARTICLE_ID_PATTERN, parseArticleArchive } from "../src/article-archive.js";
import { AuditLog } from "../src/audit-log.js";
import { createSession, credentialsMatch, readSession } from "../src/auth.js";
import { createBackup, parseBackup } from "../src/backup.js";
import { loadConfig } from "../src/config.js";
import { DerivedContentRuntime, verifyEvidence } from "../src/derived-content.js";
import { applyLaboratoryRegister, resolveKernelValues, verifySnapshot } from "../src/kernel-register.js";
import { createLaboratoryApp } from "../src/server.js";
import { BOT_POLICY_VERSION, PAGE_TYPE_REGISTRY, evidenceTextHash, renderArticlePage } from "../src/seo.js";
import { SearchNotificationRuntime } from "../src/search-notifications.js";
import { DATABASE_SCHEMA_VERSION, LaboratoryStore, validateUpload } from "../src/storage.js";
import { UpdaterClient } from "../src/updater.js";
import { GitHubArticleLibrary, articleLocation, repositoryCoordinates } from "../src/github-library.js";
import { SaturnArticleBundleClient, shareReference } from "../src/saturn-library.js";
import { placeholderNodeDefinitions } from "../../web/open-node-placeholders.js";

const defaultsDir = fileURLToPath(new URL("../../../data/defaults/", import.meta.url));

function matchCount(value, pattern) {
  return [...String(value).matchAll(pattern)].length;
}

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

test("Laboratory resolves custom Open Node types as decorative read-only nodes", async () => {
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
  const definitions = placeholderNodeDefinitions(project);
  assert.equal(definitions.length, 1);
  assert.equal(definitions[0].typeId, "laboratory.note.observation");
  assert.equal(definitions[0].version, "1.0.0");
  assert.equal(definitions[0].outputs[0].id, "idea");
  assert.deepEqual(definitions[0].createDefaultParams(), { note: "Collect source material" });
  assert.deepEqual(await definitions[0].execute(), { outputs: {} });
});

test("SEO page and bot registries define complete, versioned lifecycle contracts", () => {
  assert.match(BOT_POLICY_VERSION, /^\d{4}-\d{2}-\d{2}\.\d+$/);
  assert.deepEqual(PAGE_TYPE_REGISTRY.map((page) => page.id), ["home", "about", "journal", "article", "private", "not_found"]);
  for (const page of PAGE_TYPE_REGISTRY) {
    for (const field of ["route", "status", "rendering", "indexing", "canonical", "sitemap", "schema"]) {
      assert.ok(Object.hasOwn(page, field), `${page.id} is missing ${field}`);
    }
  }
  assert.equal(PAGE_TYPE_REGISTRY.find((page) => page.id === "article").indexing, "by_content_state");
  assert.equal(PAGE_TYPE_REGISTRY.find((page) => page.id === "private").authentication, "required");
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
    services: {
      laboratory: { sni: "laboratory.example.com", port: "443", ai: { gemini_api_key: "resolved-gemini-key" } },
      volt: { sni: "volt.example.com", port: "443" },
    },
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
  assert.equal(resolved.geminiApiKey, "resolved-gemini-key");
  assert.equal(resolved.geminiSecretRef, "");
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

test("AI pipeline accepts an in-memory value resolved through Kernel", () => {
  const library = { db: {} };
  const register = { state: { geminiApiKey: "volt-test-gemini-key-654321" }, error: "" };
  const runtime = new DerivedContentRuntime({ environment: "production" }, library, register);
  assert.deepEqual(runtime.credential(), {
    key: "volt-test-gemini-key-654321",
    source: "volt",
    error: "",
  });
  assert.equal(runtime.apiKey(), "volt-test-gemini-key-654321");
});

test("Kernel broker resolves an exact Register key without caching it", async () => {
  const key = "services.laboratory.ai.gemini_api_key";
  let request;
  const values = await resolveKernelValues({
    kernelUrl: "https://kernel.example.com",
    kernelServiceToken: "test-service-token",
    kernelTimeoutMs: 1000,
    version: "0.1.0",
  }, [key], async (url, options) => {
    request = { url, options };
    return new Response(JSON.stringify({ schema: "exocortex.register.resolution.v1", values: { [key]: { value: "resolved-secret", secret: true, volt_revision: 4 } } }), { status: 200, headers: { "content-type": "application/json" } });
  });
  assert.equal(values[key].value, "resolved-secret");
  assert.equal(request.url, "https://kernel.example.com/api/v1/register/resolve");
  assert.equal(request.options.headers.Authorization, "Bearer test-service-token");
});

test("SQLite content model seeds English pages and searchable articles", async (context) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "laboratory-store-"));
  const store = await LaboratoryStore.open({ dataDir, defaultsDir });
  assert.equal(store.db.prepare("PRAGMA user_version").get().user_version, DATABASE_SCHEMA_VERSION);
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
  assert.match(publicArticle.bodyHtml, /<h2 id="a-rendered-note">/);
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
  assert.deepEqual(articleLocation("published/My Study.zip"), { path: "published/My Study.zip", status: "published", archiveName: "My Study.zip", sourceType: "zip" });
  assert.deepEqual(articleLocation("unpublished/My Study.zip"), { path: "unpublished/My Study.zip", status: "unpublished", archiveName: "My Study.zip", sourceType: "zip" });
  assert.deepEqual(articleLocation("published/My Study.md"), { path: "published/My Study.md", status: "published", archiveName: "My Study.md", sourceType: "md" });
  assert.deepEqual(articleLocation("published/My Study.pdf"), { path: "published/My Study.pdf", status: "published", archiveName: "My Study.pdf", sourceType: "pdf" });
  assert.equal(articleLocation("misc/My Study.zip"), null);
  const raw = Buffer.from('{"zen":"safe"}');
  const secret = "github-webhook-secret";
  const signature = `sha256=${crypto.createHmac("sha256", secret).update(raw).digest("hex")}`;
  const github = new GitHubArticleLibrary({ githubWebhookSecret: secret }, { state: {} }, { getSyncState: () => ({}) });
  assert.equal(github.verifyWebhook(signature, raw), true);
  assert.throws(() => github.verifyWebhook("sha256=wrong", raw), /Invalid GitHub webhook signature/);
});

test("direct Markdown imports one Saturn folder share and strips the capability URL", async (context) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "laboratory-direct-source-"));
  const store = await LaboratoryStore.open({ dataDir, defaultsDir });
  context.after(async () => {
    store.close();
    await fs.rm(dataDir, { recursive: true, force: true });
  });
  const token = "a".repeat(43);
  const sharedUrl = `https://saturn.test/s/${token}`;
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]);
  const saturn = {
    status: () => ({ configured: true, origin: "https://saturn.test" }),
    async fetchFolder(value) {
      assert.equal(value, sharedUrl);
      return {
        files: [{ path: "media/cover.png", bytes: png }],
        remoteFiles: [{ path: "media/movie.mp4", mime: "video/mp4", size: 11 * 1024 * 1024, sha256: "d".repeat(64), storageBackend: "saturn", remoteAssetId: "asset-1", remoteVersionId: "version-1", publicUrl: "https://saturn.test/a/asset-1/movie.mp4" }],
        manifest: { schema: "laboratory.import.saturn.v1", origin: "https://saturn.test", shareId: "share-1", files: [{ path: "media/cover.png", size: png.length, mime: "image/png" }, { path: "media/movie.mp4", storage: "saturn", size: 11 * 1024 * 1024, mime: "video/mp4", sha256: "d".repeat(64) }] },
      };
    },
  };
  const github = new GitHubArticleLibrary(
    { githubToken: "", version: "test" },
    { state: { contentRepositoryUrl: "https://github.com/psewdon1m-exocortex/laboratory-library", contentRepositoryBranch: "main" } },
    store.library,
    saturn,
  );
  github.fetchFile = async () => ({
    buffer: Buffer.from(`${sharedUrl}\n\n# Direct article\n\n::image{media/cover.png}\n\n::video{src="media/movie.mp4"}\n`, "utf8"),
    sha: "blob-sha",
  });
  const imported = await github.importPath("published/Direct Article.md", "1".repeat(40), "1".repeat(40));
  assert.equal(imported.article.title, "Direct Article");
  assert.doesNotMatch(imported.article.markdownSource, /saturn\.test|\/s\//);
  assert.match(imported.article.bodyHtml, /article-image/);
  assert.match(imported.article.bodyHtml, /https:\/\/saturn\.test\/a\/asset-1\/movie\.mp4/);
  assert.equal(imported.article.files.find((file) => file.path === "media/movie.mp4").storageBackend, "saturn");
  assert.equal(JSON.parse(Buffer.from(unzipSync(imported.archive)["metadata.json"]).toString("utf8")).schema, "article.metadata.v1");
  const revision = store.library.getAdminArticle(imported.article.internalId).revisions[0];
  assert.equal(revision.sourceManifest.github.commit, "1".repeat(40));
  assert.equal(revision.sourceManifest.saturn.shareId, "share-1");
  assert.doesNotMatch(JSON.stringify(revision.sourceManifest), new RegExp(token));
  const backup = parseBackup(await createBackup(store, "hybrid-test"));
  const remoteRow = backup.snapshot.library.files.find((file) => file.remote_asset_id === "asset-1");
  assert.equal(remoteRow.storage_backend, "saturn");
  assert.equal(remoteRow.remote_version_id, "version-1");
  assert.equal(Object.keys(backup.files).some((name) => name.includes("asset-1")), false);
  await assert.rejects(() => store.library.exportArchive(imported.article.internalId), /standalone ZIP cannot preserve/);
  await assert.rejects(() => store.library.revise(imported.article.internalId, { title: "Unsafe local rewrite" }), /GitHub Markdown source/);

  const restoreDir = await fs.mkdtemp(path.join(os.tmpdir(), "laboratory-hybrid-restore-"));
  const restored = await LaboratoryStore.open({ dataDir: restoreDir, defaultsDir });
  try {
    await restored.restoreSnapshot(backup.snapshot, backup.files);
    const restoredArticle = restored.getArticle(imported.article.slug);
    assert.equal(restoredArticle.files.find((file) => file.path === "media/movie.mp4").publicUrl, "https://saturn.test/a/asset-1/movie.mp4");
  } finally {
    restored.close();
    await fs.rm(restoreDir, { recursive: true, force: true });
  }

  github.fetchFile = async () => ({ buffer: Buffer.from("%PDF-1.4\nstandalone\n", "ascii"), sha: "pdf-blob-sha" });
  const pdf = await github.importPath("published/Standalone Report.pdf", "2".repeat(40), "2".repeat(40));
  assert.equal(pdf.article.title, "Standalone Report");
  assert.equal(pdf.article.format, "pdf");

  github.config.localAssetMaxBytes = 8;
  await assert.rejects(
    () => github.importPath("published/Oversized Standalone.pdf", "3".repeat(40), "3".repeat(40)),
    /must be placed in the Saturn article folder/,
  );
});

test("Saturn bundle client accepts only the registered share origin", () => {
  const client = new SaturnArticleBundleClient(
    { version: "test", saturnUrl: "", saturnTimeoutMs: 1000 },
    { state: { saturnUrl: "https://saturn.test" } },
  );
  assert.equal(shareReference(`https://saturn.test/s/${"b".repeat(43)}`, client.origin).token, "b".repeat(43));
  assert.throws(() => shareReference(`https://evil.test/s/${"b".repeat(43)}`, client.origin), /registered Saturn origin/);
});

test("Saturn bundle client walks a shared folder with one bound session", async () => {
  const token = "c".repeat(43);
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]);
  const requests = [];
  const fetchImpl = async (input, options) => {
    const url = new URL(input);
    requests.push({ path: `${url.pathname}${url.search}`, cookie: options.headers.Cookie || "" });
    const root = `/api/v1/public/shares/${token}`;
    if (url.pathname === root) return new Response(JSON.stringify({ id: "share-id", resourceId: "folder-root", resourceType: "folder", resourceName: "25.05.2026", mode: "browse", state: "active", locked: false }), { headers: { "content-type": "application/json", "set-cookie": "vault_share_session_dev=session-token; Path=/; HttpOnly" } });
    if (url.pathname === `${root}/children` && !url.search) return Response.json([{ id: "folder-media", type: "folder", name: "media", sizeBytes: 0 }]);
    if (url.pathname === `${root}/children` && url.searchParams.get("parentId") === "folder-media") return Response.json([{ id: "file-cover", type: "file", name: "cover.png", sizeBytes: png.length, mimeType: "image/png", sha256: crypto.createHash("sha256").update(png).digest("hex") }]);
    if (url.pathname === `${root}/content/file-cover`) return new Response(png, { headers: { "content-length": String(png.length), "content-type": "image/png" } });
    return new Response("missing", { status: 404 });
  };
  const client = new SaturnArticleBundleClient(
    { version: "test", saturnUrl: "", saturnTimeoutMs: 1000 },
    { state: { saturnUrl: "https://saturn.test" } },
    fetchImpl,
  );
  const bundle = await client.fetchFolder(`https://saturn.test/s/${token}`);
  assert.equal(bundle.files[0].path, "media/cover.png");
  assert.match(bundle.files[0].sha256, /^[a-f0-9]{64}$/);
  assert.ok(requests.slice(1).every((request) => request.cookie === "vault_share_session_dev=session-token"));
});

test("Saturn bundle client keeps small files local and publishes large immutable assets", async () => {
  const token = "e".repeat(43);
  const resourceId = "01900000-0000-7000-8000-000000000111";
  const assetId = "01900000-0000-7000-8000-000000000112";
  const versionId = "01900000-0000-7000-8000-000000000113";
  const sha256 = "a".repeat(64);
  const small = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00]);
  const smallSha256 = crypto.createHash("sha256").update(small).digest("hex");
  const requests = [];
  const fetchImpl = async (input, options) => {
    const url = new URL(input);
    requests.push({ path: url.pathname, method: options.method || "GET", authorization: options.headers.Authorization || "" });
    const root = `/api/v1/public/shares/${token}`;
    if (url.pathname === root) return new Response(JSON.stringify({ id: "share-id", resourceId: "folder-root", resourceType: "folder", resourceName: "25.05.2026", mode: "browse", state: "active", locked: false }), { headers: { "set-cookie": "vault_share_session_dev=session-token; Path=/; HttpOnly" } });
    if (url.pathname === `${root}/children`) return Response.json([
      { id: "small-file", type: "file", name: "cover.png", sizeBytes: small.length, mimeType: "image/png", sha256: smallSha256 },
      { id: resourceId, type: "file", name: "movie.mp4", sizeBytes: 11, mimeType: "video/mp4", sha256 },
    ]);
    if (url.pathname === `${root}/content/small-file`) return new Response(small, { headers: { "content-length": String(small.length) } });
    if (url.pathname === "/api/v1/laboratory/imports/from-share") return Response.json({ schema: "saturn.laboratory.snapshot.v1", snapshotId: "share-id", files: [{ path: "media/movie.mp4", resourceId, asset: { id: assetId }, versionId, sizeBytes: 11, sha256, mimeType: "video/mp4", url: `https://saturn.test/a/${assetId}/movie.mp4` }] });
    return new Response("missing", { status: 404 });
  };
  const client = new SaturnArticleBundleClient(
    { version: "test", saturnUrl: "", saturnTimeoutMs: 1000, saturnClientToken: "client-token", localAssetMaxBytes: 10 },
    { state: { saturnUrl: "https://saturn.test" } },
    fetchImpl,
  );
  const bundle = await client.fetchFolder(`https://saturn.test/s/${token}`);
  assert.equal(bundle.files.length, 1);
  assert.equal(bundle.files[0].path, "media/cover.png");
  assert.deepEqual(bundle.remoteFiles[0], { path: "media/movie.mp4", mime: "video/mp4", size: 11, sha256, storageBackend: "saturn", remoteAssetId: assetId, remoteVersionId: versionId, publicUrl: `https://saturn.test/a/${assetId}/movie.mp4` });
  assert.deepEqual(requests.filter((request) => request.path.includes("/content/")).map((request) => request.path), [`/api/v1/public/shares/${token}/content/small-file`]);
  assert.equal(requests.find((request) => request.method === "POST").authorization, "Bearer client-token");
});

test("Saturn bundle client refuses a large remote asset without an immutable checksum", async () => {
  const token = "f".repeat(43);
  const root = `/api/v1/public/shares/${token}`;
  const client = new SaturnArticleBundleClient(
    { version: "test", saturnUrl: "", saturnTimeoutMs: 1000, saturnClientToken: "client-token", localAssetMaxBytes: 10 },
    { state: { saturnUrl: "https://saturn.test" } },
    async (input) => {
      const url = new URL(input);
      if (url.pathname === root) return new Response(JSON.stringify({ id: "share-id", resourceId: "folder-root", resourceType: "folder", resourceName: "25.05.2026", mode: "browse", state: "active", locked: false }), { headers: { "set-cookie": "vault_share_session_dev=session-token; Path=/; HttpOnly" } });
      if (url.pathname === `${root}/children`) return Response.json([{ id: "large-file", type: "file", name: "movie.mp4", sizeBytes: 11, mimeType: "video/mp4" }]);
      throw new Error(`Unexpected request: ${url.pathname}`);
    },
  );
  await assert.rejects(() => client.fetchFolder(`https://saturn.test/s/${token}`), /did not provide a checksum/);
});

test("GitHub webhook jobs are durable, deduplicated and branch-scoped", async (context) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "laboratory-github-jobs-"));
  const store = await LaboratoryStore.open({ dataDir, defaultsDir });
  context.after(async () => {
    store.close();
    await fs.rm(dataDir, { recursive: true, force: true });
  });
  const github = new GitHubArticleLibrary(
    { githubToken: "", version: "test", githubImportMaxAttempts: 3 },
    { state: { contentRepositoryUrl: "https://github.com/psewdon1m-exocortex/laboratory-library", contentRepositoryBranch: "main" } },
    store.library,
  );
  const payload = {
    ref: "refs/heads/main",
    before: "1".repeat(40),
    after: "2".repeat(40),
    repository: { full_name: "psewdon1m-exocortex/laboratory-library" },
  };
  assert.throws(() => github.validatePush({ ...payload, ref: "refs/heads/draft" }), /branch does not match/);
  assert.equal(github.enqueuePush(payload, "delivery-1").queued, true);
  assert.equal(github.enqueuePush(payload, "delivery-1").duplicate, true);
  assert.equal(store.library.db.prepare("SELECT status FROM github_import_jobs WHERE delivery_id = ?").get("delivery-1").status, "pending");
  github.syncRepository = async (after, before) => {
    assert.equal(after, payload.after);
    assert.equal(before, payload.before);
    return { imported: [], errors: [], moved: [], deleted: [] };
  };
  await github.tick();
  assert.deepEqual(
    { ...store.library.db.prepare("SELECT status, attempts, last_error FROM github_import_jobs WHERE delivery_id = ?").get("delivery-1") },
    { status: "complete", attempts: 1, last_error: null },
  );
});

test("GitHub push deletions durably archive repository-backed articles", async (context) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "laboratory-github-delete-"));
  let store = await LaboratoryStore.open({ dataDir, defaultsDir });
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
  assert.equal(store.getArticle(imported.article.slug), null);
  const retained = store.library.getAdminArticle(imported.article.internalId);
  assert.equal(retained.status, "unpublished");
  assert.equal(retained.revisions.length, 1);
  store.close();
  store = await LaboratoryStore.open({ dataDir, defaultsDir });
  assert.equal(store.getArticle(imported.article.slug), null);
  assert.equal(store.library.getAdminArticle(imported.article.internalId).revisions.length, 1);
  await store.library.importArchive(articleZip("# Removed through Git"), {
    archiveName: "Delete Through Git.zip",
    status: "published",
    sourceKind: "github",
    sourcePath,
  });
  assert.equal(store.getArticle(imported.article.slug).internalId, imported.article.internalId);
  assert.equal(store.library.getAdminArticle(imported.article.internalId).revisions.length, 2);
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
  assert.ok(backup.snapshot.contentEvents.length >= 1);
  const sourceFreshness = source.publicContentModifiedAt();
  const restored = await restore.restoreSnapshot(backup.snapshot, backup.files);
  assert.equal(restored.articles, 4);
  const article = restore.getArticle(publication.article.slug);
  assert.equal(article.internalId, publication.article.internalId);
  assert.match(article.bodyHtml, /Preserved revision/);
  assert.equal(restore.library.getAdminArticle(article.internalId).revisions.length, 1);
  assert.equal(restore.publicContentModifiedAt(), sourceFreshness);
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
  const pdfPage = renderArticlePage(articleTemplate, {
    content: store.getContent(),
    article: {
      ...article,
      format: "pdf",
      pdfUrl: "/api/article-assets/test/article.pdf",
      transcriptHtml: "<h2 id=\"generated-transcript\">Generated transcript</h2><p>Faithful visible PDF text.</p>",
    },
    baseUrl: "https://laboratory.example.com",
    nonce: "test-nonce",
    authorName: "c31e1b26",
  });
  assert.match(pdfPage, /<summary>Text version<\/summary>/);
  assert.match(pdfPage, /Faithful visible PDF text/);
  assert.equal(matchCount(pdfPage, /<h1\b/gi), 1);
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
    app.locals.laboratory.githubLibrary.stop();
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
  assert.equal(matchCount(aboutHtml, /<h1\b/gi), 1);
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
  const contentModifiedBefore = current.updatedAt;
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
  assert.notEqual(updatedContent.updatedAt, contentModifiedBefore);
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
  assert.match(publishedPage, /<h2 id="http-publication">/);
  assert.equal(matchCount(publishedPage, /<h1\b/gi), 1);
  for (const resource of ["/journal", "/sitemaps/articles-0001.xml", "/llms.txt", "/feed.xml", "/journal.md"]) {
    assert.match(await (await fetch(`${baseUrl}${resource}`)).text(), new RegExp(importedBody.article.slug));
  }
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
  const pageBeforeRename = await fetch(`${baseUrl}/journal/${importedBody.article.slug}`);
  const pageLastModified = pageBeforeRename.headers.get("last-modified");
  const pageEtag = pageBeforeRename.headers.get("etag");
  await pageBeforeRename.text();
  const renamed = await fetch(`${baseUrl}/api/admin/articles/${importedBody.article.internalId}`, {
    method: "PUT",
    headers: { Cookie: cookie, "Content-Type": "application/json", "X-CSRF-Token": session.csrfToken },
    body: JSON.stringify({ title: "HTTP Publication Renamed" }),
  });
  assert.equal(renamed.status, 200);
  const renamedArticle = (await renamed.json()).article;
  assert.ok(renamedArticle.revisedAt);
  const conditionallyRefetched = await fetch(`${baseUrl}/journal/${importedBody.article.slug}`, {
    headers: { "If-Modified-Since": pageLastModified },
  });
  assert.equal(conditionallyRefetched.status, 200);
  assert.notEqual(conditionallyRefetched.headers.get("etag"), pageEtag);
  const renamedHtml = await conditionallyRefetched.text();
  assert.match(renamedHtml, /HTTP Publication Renamed/);
  assert.match(renamedHtml, /revised/);
  const renamedMachineArticle = await (await fetch(`${baseUrl}/api/public/v2/articles/${importedBody.article.internalId}`)).json();
  assert.notEqual(renamedMachineArticle.contentModifiedAt, renamedMachineArticle.publishedAt);
  const adminDetail = await fetch(`${baseUrl}/api/admin/articles/${importedBody.article.internalId}`, { headers: { Cookie: cookie } });
  assert.equal(adminDetail.status, 200);
  assert.equal((await adminDetail.json()).revisions.length, 2);

  const sitemapBeforeDelete = await fetch(`${baseUrl}/sitemaps/articles-0001.xml`);
  const sitemapLastModified = sitemapBeforeDelete.headers.get("last-modified");
  await sitemapBeforeDelete.text();
  const deleted = await fetch(`${baseUrl}/api/admin/articles/${importedBody.article.internalId}`, {
    method: "DELETE",
    headers: { Cookie: cookie, "X-CSRF-Token": session.csrfToken },
  });
  assert.equal(deleted.status, 200);
  assert.equal((await deleted.json()).deleted.internalId, importedBody.article.internalId);
  assert.equal((await fetch(`${baseUrl}/api/articles/${importedBody.article.slug}`)).status, 404);
  const sitemapAfterDelete = await fetch(`${baseUrl}/sitemaps/articles-0001.xml`, {
    headers: { "If-Modified-Since": sitemapLastModified },
  });
  assert.equal(sitemapAfterDelete.status, 200);
  assert.doesNotMatch(await sitemapAfterDelete.text(), new RegExp(importedBody.article.slug));
  for (const resource of ["/journal", "/llms.txt", "/feed.xml", "/journal.md"]) {
    assert.doesNotMatch(await (await fetch(`${baseUrl}${resource}`)).text(), new RegExp(importedBody.article.slug));
  }
  const evidenceAfterDelete = await (await fetch(`${baseUrl}/api/public/v2/evidence?q=created`)).json();
  assert.ok(!evidenceAfterDelete.articles.some((article) => article.id === importedBody.article.internalId));
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
