import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import cookieParser from "cookie-parser";
import express from "express";
import multer from "multer";
import {
  LoginLimiter,
  authMiddleware,
  clearSessionCookie,
  createSession,
  credentialsMatch,
  setSessionCookie,
} from "./auth.js";
import { createBackup, MAX_ARCHIVE_BYTES, parseBackup } from "./backup.js";
import { AgentCatalog } from "./agent-catalog.js";
import { AuditLog } from "./audit-log.js";
import { MAX_ARTICLE_ARCHIVE_BYTES } from "./article-archive.js";
import { renderMarkdownDocument } from "./article-markdown.js";
import { loadConfig } from "./config.js";
import { DerivedContentRuntime } from "./derived-content.js";
import { EvidenceIndex } from "./evidence-index.js";
import { GitHubArticleLibrary } from "./github-library.js";
import { KernelRegisterRuntime } from "./kernel-register.js";
import { createNeptuneClient } from "./neptune-client.js";
import { handleMcpRequest, mcpCors } from "./mcp.js";
import { FixedWindowRateLimiter, publicCors, registerPublicApi } from "./public-api.js";
import {
  articleDescription,
  buildArticlesSitemap,
  buildFeed,
  buildLlms,
  buildPagesSitemap,
  buildRobots,
  buildSitemapIndex,
  evidenceOpenApi,
  publicBaseUrl,
  renderAboutPage,
  renderArticlePage,
  renderHomePage,
  renderJournalPage,
} from "./seo.js";
import { SearchNotificationRuntime } from "./search-notifications.js";
import { SaturnArticleBundleClient } from "./saturn-library.js";
import { LaboratoryStore, UPLOAD_SLOTS } from "./storage.js";
import { UpdaterClient, checkGithubRelease } from "./updater.js";

function safeCompare(left, right) {
  const a = Buffer.from(String(left ?? ""));
  const b = Buffer.from(String(right ?? ""));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function requestKey(req) {
  return req.ip || req.socket.remoteAddress || "unknown";
}

function htmlRoute(app, route, filename, publicDir) {
  app.get(route, (_req, res) => res.sendFile(filename, { root: publicDir }));
}

export async function createLaboratoryApp(overrides = {}) {
  const config = loadConfig(overrides);
  const store = await LaboratoryStore.open(config);
  const register = new KernelRegisterRuntime(config);
  await register.start();
  const updater = new UpdaterClient(config);
  const neptune = createNeptuneClient(config);
  const saturnLibrary = new SaturnArticleBundleClient(config, register);
  const githubLibrary = new GitHubArticleLibrary(config, register, store.library, saturnLibrary);
  githubLibrary.start();
  const derivedContent = new DerivedContentRuntime(config, store.library, register);
  await derivedContent.start();
  const searchNotifications = new SearchNotificationRuntime(config, store.library, register);
  searchNotifications.start();
  const auth = authMiddleware(config);
  const audit = new AuditLog(config);
  await audit.initialize();
  const loginLimiter = new LoginLimiter();
  const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: config.maxUploadBytes, files: 1, fields: 8 },
  });
  const articleUpload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: MAX_ARTICLE_ARCHIVE_BYTES, files: 1, fields: 12 },
  });
  const backupUpload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: MAX_ARCHIVE_BYTES, files: 1, fields: 2 },
  });
  const templates = new Map(["index.html", "about.html", "journal.html", "article.html"].map((filename) => [
    filename,
    fs.readFileSync(path.join(config.publicDir, filename), "utf8"),
  ]));
  const content = () => ({ ...store.getContent(), language: config.defaultLanguage });
  const baseUrl = (req) => publicBaseUrl(req, config, register);
  const publishedArticles = () => store.listArticles({ sort: "newest" });
  const publishedArticleDetails = () => publishedArticles().map((article) => store.getArticle(article.slug)).filter(Boolean);
  const contentModifiedAt = (scopes, entityId = null) => store.contentModifiedAt(scopes, entityId);
  const aboutPage = async () => {
    const markdown = await store.readAsset("aboutMarkdown");
    return {
      bodyHtml: markdown ? renderMarkdownDocument(markdown.data.toString("utf8"), { headingOffset: 1 }) : "",
      updatedAt: markdown?.updated_at ?? null,
    };
  };
  const pageModifiedDates = async () => {
    return {
      home: contentModifiedAt(["site", "home"]),
      about: contentModifiedAt(["site", "about"]),
      journal: contentModifiedAt(["site", "journal"]),
    };
  };
  const readAboutMarkdown = async () => {
    const markdown = await store.readAsset("aboutMarkdown");
    return markdown ? markdown.data.toString("utf8") : "";
  };
  const evidenceIndex = new EvidenceIndex(store, { language: config.defaultLanguage });
  const agentCatalog = new AgentCatalog({
    store, evidenceIndex, config, content, aboutPage, readAboutMarkdown,
  });
  const sendText = (res, type, value, cache = "public, max-age=0, must-revalidate") => {
    const bytes = Buffer.from(String(value));
    const etag = `"${crypto.createHash("sha256").update(bytes).digest("base64url")}"`;
    res.setHeader("Content-Type", type);
    res.setHeader("Cache-Control", cache);
    res.setHeader("ETag", etag);
    const requestEtags = String(res.req?.headers?.["if-none-match"] || "").split(",").map((item) => item.trim());
    const modifiedSince = Date.parse(String(res.req?.headers?.["if-modified-since"] || ""));
    const lastModified = Date.parse(String(res.getHeader("Last-Modified") || ""));
    if (requestEtags.includes(etag)
      || (!requestEtags.some(Boolean) && Number.isFinite(modifiedSince) && Number.isFinite(lastModified) && lastModified <= modifiedSince)) {
      return res.status(304).end();
    }
    res.send(bytes);
  };
  const setLastModified = (res, value) => {
    const timestamp = value ? new Date(value) : null;
    if (timestamp && Number.isFinite(timestamp.getTime())) res.setHeader("Last-Modified", timestamp.toUTCString());
  };
  const setAgentLinks = (req, res, markdownPath = "", canonicalPath = "", preconnectOrigins = []) => {
    const origin = baseUrl(req);
    const values = [
      `<${new URL("/llms.txt", `${origin}/`)}>; rel="describedby"; type="text/markdown"`,
      `<${new URL("/api/public/v2/openapi.json", `${origin}/`)}>; rel="service-desc"; type="application/vnd.oai.openapi+json"`,
      `<${new URL("/mcp", `${origin}/`)}>; rel="service"; type="application/json"`,
    ];
    if (canonicalPath) values.unshift(`<${new URL(canonicalPath, `${origin}/`)}>; rel="canonical"`);
    if (markdownPath) values.unshift(`<${new URL(markdownPath, `${origin}/`)}>; rel="alternate"; type="text/markdown"`);
    for (const remoteOrigin of new Set(preconnectOrigins)) values.push(`<${remoteOrigin}>; rel="preconnect"`);
    res.setHeader("Link", values.join(", "));
  };
  const restoreFromBuffer = async (buffer) => {
    const parsed = parseBackup(buffer);
    const restorePoint = await createBackup(store, config.version);
    await store.saveRestorePoint(restorePoint);
    return store.restoreSnapshot(parsed.snapshot, parsed.files);
  };

  const app = express();
  if (config.trustProxy) app.set("trust proxy", 1);
  app.disable("x-powered-by");
  app.use((req, res, next) => {
    req.requestId = req.get("X-Request-ID") || crypto.randomUUID();
    req.cspNonce = crypto.randomBytes(18).toString("base64url");
    res.setHeader("X-Request-ID", req.requestId);
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
    res.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
    res.setHeader("Cross-Origin-Opener-Policy", "same-origin");
    const saturnOrigin = register.state.saturnUrl || config.saturnUrl || "";
    res.setHeader(
      "Content-Security-Policy",
      `default-src 'self'; script-src 'self' 'nonce-${req.cspNonce}'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; img-src 'self' data: blob: ${saturnOrigin}; media-src 'self' ${saturnOrigin}; connect-src 'self' ${saturnOrigin}; worker-src 'self' blob:; object-src 'none'; base-uri 'self'; frame-ancestors 'none'; form-action 'self'`,
    );
    if (store.restoreInProgress && req.path !== "/api/health") {
      res.setHeader("Retry-After", "5");
      return res.status(503).json({ error: "Laboratory restore is in progress", requestId: req.requestId });
    }
    const auditable = req.path === "/api/admin/login"
      || req.path.startsWith("/api/admin/")
      || req.path.startsWith("/api/updates/")
      || req.path === "/api/github/webhook"
      || req.path === "/api/internal/updater/restore";
    if (auditable && (req.method !== "GET" || req.path.includes("backup") || req.path.includes("audit"))) {
      res.once("finish", () => {
        const actor = auth.session(req)?.username || (req.path === "/api/internal/updater/restore" ? "updater" : "anonymous");
        void audit.write({
          requestId: req.requestId,
          actor,
          remoteAddress: req.ip || req.socket.remoteAddress,
          action: `${req.method} ${req.path}`,
          outcome: res.statusCode < 400 ? "success" : "failure",
          status: res.statusCode,
        });
      });
    }
    next();
  });
  app.use(express.json({
    limit: "2mb",
    verify(req, _res, buffer) {
      if (req.path === "/api/github/webhook") req.rawBody = Buffer.from(buffer);
    },
  }));
  app.use(cookieParser());

  app.use("/api", (_req, res, next) => {
    res.setHeader("X-Robots-Tag", "noindex, nofollow");
    next();
  });
  const publicApiLimiter = new FixedWindowRateLimiter({ limit: config.publicApiRateLimit, windowMs: 60_000 });
  const mcpLimiter = new FixedWindowRateLimiter({ limit: config.mcpRateLimit, windowMs: 60_000 });
  app.use("/api/public", publicCors, publicApiLimiter.middleware(requestKey));
  app.use("/mcp", mcpCors, mcpLimiter.middleware(requestKey));

  app.get("/api/health", (_req, res) => {
    res.json({ status: "ok", service: "laboratory", version: config.version });
  });

  app.get("/api/content", (_req, res) => res.json(store.getContent()));

  app.get("/api/about", async (_req, res, next) => {
    try {
      res.json(await aboutPage());
    } catch (error) { next(error); }
  });

  app.get("/api/public/v1/openapi.json", (req, res) => {
    res.setHeader("Cache-Control", "public, max-age=3600, stale-while-revalidate=86400");
    res.json(evidenceOpenApi(baseUrl(req)));
  });

  app.get("/api/public/v1/articles", (req, res) => {
    const origin = baseUrl(req);
    const site = content();
    const items = publishedArticleDetails().map((item) => ({
      id: item.internalId,
      slug: item.slug,
      title: item.title,
      description: articleDescription(item, site.siteTitle),
      canonicalUrl: new URL(`/journal/${encodeURIComponent(item.slug)}`, `${origin}/`).toString(),
      format: item.format,
      publishedAt: item.publishedAt,
      contentModifiedAt: item.revisedAt || item.publishedAt,
      language: config.defaultLanguage,
    }));
    res.setHeader("Cache-Control", "public, max-age=0, must-revalidate");
    res.json({ items });
  });

  app.get("/api/public/v1/articles/:slug", (req, res) => {
    const article = store.getArticle(req.params.slug);
    if (!article) return res.status(404).json({ error: "Article not found" });
    const origin = baseUrl(req);
    const site = content();
    res.setHeader("Cache-Control", "public, max-age=0, must-revalidate");
    res.json({
      id: article.internalId,
      slug: article.slug,
      title: article.title,
      description: articleDescription(article, site.siteTitle),
      canonicalUrl: new URL(`/journal/${encodeURIComponent(article.slug)}`, `${origin}/`).toString(),
      format: article.format,
      publishedAt: article.publishedAt,
      contentModifiedAt: article.revisedAt || article.publishedAt,
      language: config.defaultLanguage,
      sources: article.metadata?.sources || [],
      abstractUrl: article.abstractUrl ? new URL(article.abstractUrl, `${origin}/`).toString() : null,
      transcriptUrl: article.transcriptUrl ? new URL(article.transcriptUrl, `${origin}/`).toString() : null,
      derivedContent: article.derivedContent,
      evidence: evidenceIndex.forArticle(article.internalId, origin),
    });
  });

  app.get("/api/public/v1/evidence", (req, res) => {
    const offset = Math.max(0, Math.min(10_000, Number.parseInt(req.query.offset, 10) || 0));
    const result = evidenceIndex.search({
      query: req.query.q, mode: req.query.mode, limit: req.query.limit, offset,
      baseUrl: baseUrl(req),
    });
    res.setHeader("Cache-Control", "public, max-age=0, must-revalidate");
    res.json({ query: result.query, mode: result.mode, count: result.items.length, total: result.total, offset, items: result.items });
  });

  registerPublicApi(app, { catalog: agentCatalog, evidenceIndex, baseUrl });

  app.post("/mcp", async (req, res, next) => {
    try {
      res.setHeader("X-Robots-Tag", "noindex, nofollow");
      res.setHeader("Cache-Control", "no-store");
      await handleMcpRequest(req, res, {
        catalog: agentCatalog, evidenceIndex, baseUrl: baseUrl(req), version: config.version,
      });
    } catch (error) { next(error); }
  });
  app.get("/mcp", (_req, res) => res.status(405).set("Allow", "POST, OPTIONS").json({ error: "Use MCP Streamable HTTP POST requests" }));

  app.get("/api/articles", (req, res) => {
    const sort = req.query.sort === "oldest" ? "oldest" : "newest";
    const query = String(req.query.q ?? "").slice(0, 100);
    res.json({ items: store.listArticles({ query, sort }), query, sort });
  });

  app.get("/api/articles/:slug", (req, res) => {
    const article = store.getArticle(req.params.slug);
    if (!article) return res.status(404).json({ error: "Article not found" });
    res.json(article);
  });

  app.get(/^\/api\/article-assets\/(l-[0-9A-HJKMNP-TV-Z]{12})\/(\d+)\/(.+)$/, async (req, res, next) => {
    try {
      const result = await store.library.getFile(req.params[0], Number(req.params[1]), decodeURIComponent(req.params[2]));
      if (!result) return res.status(404).json({ error: "Article file not found" });
      if (result.remoteUrl) return res.redirect(302, result.remoteUrl);
      res.setHeader("Content-Type", result.file.mime || "application/octet-stream");
      res.setHeader("Content-Length", String(result.bytes.length));
      res.setHeader("Cache-Control", config.environment === "production" ? "public, max-age=31536000, immutable" : "no-cache");
      if (result.file.kind === "main" && result.file.mime === "application/pdf") {
        const canonical = new URL(`/journal/${encodeURIComponent(result.article.slug)}`, `${baseUrl(req)}/`).toString();
        res.setHeader("Link", `<${canonical}>; rel="canonical"`);
        res.setHeader("Content-Location", canonical);
      }
      if (result.file.kind === "attachment") {
        res.setHeader("Content-Disposition", `attachment; filename*=UTF-8''${encodeURIComponent(path.basename(result.file.path))}`);
      }
      res.send(result.bytes);
    } catch (error) { next(error); }
  });

  app.get(/^\/api\/article-derived\/(l-[0-9A-HJKMNP-TV-Z]{12})\/(\d+)\/([a-z0-9-]{8,80})\/(abstract\.md|transcript\.md|evidence\.json|generation-manifest\.json)$/, async (req, res, next) => {
    try {
      const result = await store.library.getDerivedFile(req.params[0], Number(req.params[1]), req.params[2], req.params[3]);
      if (!result) return res.status(404).json({ error: "Derived article file not found" });
      res.setHeader("Content-Type", result.mime);
      res.setHeader("Cache-Control", config.environment === "production" ? "public, max-age=31536000, immutable" : "no-cache");
      res.send(result.bytes);
    } catch (error) { next(error); }
  });
  app.get(/^\/api\/article-derived\/(l-[0-9A-HJKMNP-TV-Z]{12})\/(\d+)\/(abstract\.md|transcript\.md|evidence\.json|generation-manifest\.json)$/, async (req, res, next) => {
    try {
      const result = await store.library.getDerivedFile(req.params[0], Number(req.params[1]), null, req.params[2]);
      if (!result) return res.status(404).json({ error: "Derived article file not found" });
      res.setHeader("Content-Type", result.mime);
      res.setHeader("Cache-Control", "no-store");
      res.setHeader("Deprecation", "true");
      res.send(result.bytes);
    } catch (error) { next(error); }
  });

  app.get(/^\/api\/article-workflows\/(l-[0-9A-HJKMNP-TV-Z]{12})\/(\d+)\/(.+)$/, async (req, res, next) => {
    try {
      const result = await store.library.getFile(req.params[0], Number(req.params[1]), decodeURIComponent(req.params[2]), { workflow: true });
      if (!result) return res.status(404).json({ error: "Article workflow not found" });
      res.setHeader("Cache-Control", config.environment === "production" ? "public, max-age=31536000, immutable" : "no-cache");
      res.json(result.project);
    } catch (error) { next(error); }
  });

  app.post("/api/github/webhook", async (req, res, next) => {
    try {
      githubLibrary.verifyWebhook(req.get("X-Hub-Signature-256"), req.rawBody || Buffer.alloc(0));
      const event = req.get("X-GitHub-Event");
      if (event === "ping") return res.json({ accepted: true, event });
      if (event !== "push") return res.status(202).json({ accepted: true, ignored: event || "unknown" });
      const payload = structuredClone(req.body);
      const rawBody = req.rawBody || Buffer.alloc(0);
      const deliveryId = req.get("X-GitHub-Delivery") || `sha256:${crypto.createHash("sha256").update(rawBody).digest("hex")}`;
      const queued = githubLibrary.enqueuePush(payload, deliveryId);
      res.status(202).json({ accepted: true, event, ...queued });
    } catch (error) { next(error); }
  });

  app.post("/api/admin/login", (req, res, next) => {
    try {
      const key = requestKey(req);
      loginLimiter.check(key);
      const username = String(req.body?.username ?? "");
      const password = String(req.body?.password ?? "");
      if (!credentialsMatch(username, password, config)) {
        return res.status(401).json({ error: "Invalid credentials" });
      }
      loginLimiter.clear(key);
      const session = createSession(config.adminUsername, config.sessionSecret);
      setSessionCookie(res, session.token, config);
      res.json({ authenticated: true, username: config.adminUsername, csrfToken: session.csrf });
    } catch (error) {
      next(error);
    }
  });

  app.get("/api/admin/session", auth.requireAdmin, (req, res) => {
    res.json({ authenticated: true, username: config.adminUsername, csrfToken: req.adminSession.csrf });
  });

  app.post("/api/admin/logout", auth.requireMutation, (_req, res) => {
    clearSessionCookie(res, config);
    res.json({ authenticated: false });
  });

  app.get("/api/admin/state", auth.requireAdmin, async (_req, res) => {
    res.json({
      content: store.getContent(),
      articles: store.listArticles({ includeDrafts: true }),
      runtime: {
        version: config.version,
        registerRevision: register.state.revision,
        registerError: register.error,
        repositoryUrl: register.state.repositoryUrl,
        contentLibrary: githubLibrary.status(),
        derivedContent: derivedContent.status(),
        searchNotifications: searchNotifications.status(),
        publicUrl: register.state.publicUrl,
        updater: await updater.status(),
      },
    });
  });

  app.put("/api/admin/content", auth.requireMutation, (req, res, next) => {
    try { res.json(store.updateContent(req.body ?? {})); }
    catch (error) { next(error); }
  });

  app.post("/api/admin/upload/:slot", auth.requireMutation, (req, res, next) => {
    const slot = req.params.slot;
    if (!UPLOAD_SLOTS[slot]) return res.status(400).json({ error: "Unknown upload slot" });
    upload.single("file")(req, res, async (error) => {
      if (error) return next(error);
      try { res.json(await store.saveAsset(slot, req.file)); }
      catch (uploadError) { next(uploadError); }
    });
  });

  app.delete("/api/admin/upload/:slot", auth.requireMutation, async (req, res, next) => {
    try { res.json(await store.removeAsset(req.params.slot)); }
    catch (error) { next(error); }
  });

  app.get("/api/admin/articles/:id", auth.requireAdmin, (req, res) => {
    const article = store.library.getAdminArticle(req.params.id);
    if (!article) return res.status(404).json({ error: "Article not found" });
    res.json(article);
  });

  app.get("/api/admin/articles/:id/archive", auth.requireAdmin, async (req, res, next) => {
    try {
      const article = store.library.getAdminArticle(req.params.id);
      if (!article) return res.status(404).json({ error: "Article not found" });
      const archive = await store.library.exportArchive(req.params.id);
      res.setHeader("Content-Type", "application/zip");
      res.setHeader("Content-Disposition", `attachment; filename*=UTF-8''${encodeURIComponent(`${article.title}.zip`)}`);
      res.send(archive);
    } catch (error) { next(error); }
  });

  app.post("/api/admin/articles/import", auth.requireMutation, (req, res, next) => {
    articleUpload.single("file")(req, res, async (error) => {
      if (error) return next(error);
      try {
        const result = await store.library.importArchive(req.file?.buffer, {
          archiveName: req.file?.originalname,
          title: req.body?.title || undefined,
          status: req.body?.status || "published",
          sourceKind: "admin",
        });
        const writeback = await githubLibrary.writeArticle(result);
        res.status(result.changed ? 201 : 200).json({ ...result, archive: undefined, writeback });
      } catch (importError) { next(importError); }
    });
  });

  app.put("/api/admin/articles/:id", auth.requireMutation, async (req, res, next) => {
    try {
      const result = await store.library.revise(req.params.id, req.body || {});
      const writeback = await githubLibrary.writeArticle(result);
      res.json({ ...result, archive: undefined, writeback });
    } catch (error) { next(error); }
  });

  app.post("/api/admin/articles/:id/derivatives/regenerate", auth.requireMutation, (req, res, next) => {
    try { res.status(202).json(derivedContent.regenerate(req.params.id)); }
    catch (error) { next(error); }
  });

  app.post("/api/admin/articles/:id/main", auth.requireMutation, (req, res, next) => {
    articleUpload.single("file")(req, res, async (error) => {
      if (error) return next(error);
      try {
        const result = await store.library.replaceMain(req.params.id, req.file, req.body || {});
        const writeback = await githubLibrary.writeArticle(result);
        res.json({ ...result, archive: undefined, writeback });
      } catch (replaceError) { next(replaceError); }
    });
  });

  app.post("/api/admin/articles/:id/files/:folder", auth.requireMutation, (req, res, next) => {
    articleUpload.single("file")(req, res, async (error) => {
      if (error) return next(error);
      try {
        const result = await store.library.addFile(req.params.id, req.params.folder, req.file);
        const writeback = await githubLibrary.writeArticle(result);
        res.json({ ...result, archive: undefined, writeback });
      } catch (fileError) { next(fileError); }
    });
  });

  app.delete("/api/admin/articles/:id/files", auth.requireMutation, async (req, res, next) => {
    try {
      const result = await store.library.removeFile(req.params.id, String(req.query.path || ""));
      const writeback = await githubLibrary.writeArticle(result);
      res.json({ ...result, archive: undefined, writeback });
    } catch (error) { next(error); }
  });

  app.delete("/api/admin/articles/:id", auth.requireMutation, async (req, res, next) => {
    try {
      const article = store.library.getAdminArticle(req.params.id);
      if (!article) return res.status(404).json({ error: "Article not found" });
      const writeback = await githubLibrary.deleteArticle(article);
      const deleted = await store.library.deleteArticle(req.params.id);
      res.json({ deleted, writeback });
    } catch (error) { next(error); }
  });

  app.post("/api/admin/library/sync", auth.requireMutation, async (_req, res, next) => {
    try { res.json(await githubLibrary.syncRepository()); }
    catch (error) { next(error); }
  });

  app.get("/api/admin/backup", auth.requireAdmin, async (_req, res, next) => {
    try {
      const archive = await createBackup(store, config.version);
      const stamp = new Date().toISOString().replace(/[-:TZ.]/g, "").slice(0, 14);
      res.setHeader("Content-Type", "application/zip");
      res.setHeader("Content-Disposition", `attachment; filename="laboratory-backup-${stamp}.zip"`);
      res.send(archive);
    } catch (error) { next(error); }
  });

  app.post("/api/internal/neptune/backup", async (req, res, next) => {
    try {
      if (!config.neptuneExportTokenFile || !fs.existsSync(config.neptuneExportTokenFile)
        || !safeCompare(req.get("Authorization"), `Bearer ${fs.readFileSync(config.neptuneExportTokenFile, "utf8").trim()}`)) {
        return res.status(401).json({ error: "Unauthorized" });
      }
      const archive = await createBackup(store, config.version);
      const checksum = crypto.createHash("sha256").update(archive).digest("hex");
      res.setHeader("Content-Type", "application/zip");
      res.setHeader("Content-Length", String(archive.length));
      res.setHeader("X-Neptune-Archive-Sha256", checksum);
      res.setHeader("X-Neptune-Source-Version", config.version);
      res.send(archive);
    } catch (error) { next(error); }
  });

  app.get("/api/neptune/status", auth.requireAdmin, async (_req, res, next) => {
    try { res.json(await neptune.status()); } catch (error) { next(error); }
  });

  app.put("/api/neptune/schedule", auth.requireMutation, async (req, res, next) => {
    try {
      const enabled = req.body?.enabled;
      const intervalHours = Number(req.body?.interval_hours);
      if (typeof enabled !== "boolean" || !Number.isInteger(intervalHours) || intervalHours < 1 || intervalHours > 8760) {
        return res.status(400).json({ error: "Interval must be a whole number of hours between 1 and 8760" });
      }
      await neptune.schedule(enabled, intervalHours);
      res.status(204).send();
    } catch (error) { next(error); }
  });

  app.post("/api/neptune/runs", auth.requireMutation, async (_req, res, next) => {
    try { res.status(202).json(await neptune.run()); } catch (error) { next(error); }
  });

  app.post("/api/neptune/update/check", auth.requireMutation, async (_req, res, next) => {
    try {
      const status = await neptune.status();
      res.json(await checkGithubRelease(register.state.neptuneRepositoryUrl, status.version, 5000, "neptune-linux"));
    } catch (error) { next(error); }
  });

  app.post("/api/neptune/update/install", auth.requireMutation, async (req, res, next) => {
    try {
      const requestedVersion = String(req.body?.version ?? "");
      const status = await neptune.status();
      const update = await checkGithubRelease(register.state.neptuneRepositoryUrl, status.version, 5000, "neptune-linux");
      if (!update.update_available || update.available_version !== requestedVersion) {
        return res.status(409).json({ error: "Requested Neptune version is not the current upgrade candidate" });
      }
      res.json(await updater.updateNeptune(requestedVersion));
    } catch (error) { next(error); }
  });

  app.get("/api/admin/audit", auth.requireAdmin, async (req, res, next) => {
    try { res.json({ events: await audit.list(Number.parseInt(req.query.limit, 10) || 200) }); }
    catch (error) { next(error); }
  });

  app.get("/api/admin/audit/export", auth.requireAdmin, async (_req, res, next) => {
    try {
      const stamp = new Date().toISOString().replace(/[-:TZ.]/g, "").slice(0, 14);
      res.setHeader("Content-Type", "application/x-ndjson; charset=utf-8");
      res.setHeader("Content-Disposition", `attachment; filename="laboratory-audit-${stamp}.jsonl"`);
      res.setHeader("Cache-Control", "private, no-store");
      res.send(await audit.exportJsonl());
    } catch (error) { next(error); }
  });

  app.post("/api/admin/restore", auth.requireMutation, (req, res, next) => {
    backupUpload.single("file")(req, res, async (error) => {
      if (error) return next(error);
      try {
        res.json({ restored: await restoreFromBuffer(req.file?.buffer) });
      } catch (restoreError) { next(restoreError); }
    });
  });

  app.get("/api/updates/status", auth.requireAdmin, async (_req, res) => {
    res.json({ installedVersion: config.version, repositoryUrl: register.state.repositoryUrl, updater: await updater.status() });
  });

  app.post("/api/updates/check", auth.requireMutation, async (_req, res, next) => {
    try { res.json(await checkGithubRelease(register.state.repositoryUrl, config.version)); }
    catch (error) { next(error); }
  });

  app.post("/api/updates/apply", auth.requireMutation, async (req, res, next) => {
    try {
      const version = String(req.body?.version ?? "");
      if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) throw new Error("Invalid release version");
      const backup = await createBackup(store, config.version);
      const stamp = new Date().toISOString().replace(/[-:TZ.]/g, "").slice(0, 14);
      res.status(202).json(await updater.createUpdate(version, `laboratory-backup-${stamp}.zip`, backup));
    } catch (error) { next(error); }
  });

  app.get("/api/updates/jobs/:id", auth.requireAdmin, async (req, res, next) => {
    try { res.json(await updater.job(req.params.id)); }
    catch (error) { next(error); }
  });

  app.post("/api/updates/jobs/:id/rollback", auth.requireMutation, async (req, res, next) => {
    try { res.status(202).json(await updater.rollback(req.params.id)); }
    catch (error) { next(error); }
  });

  app.post("/api/internal/updater/restore", (req, res, next) => {
    if (!config.updaterControlToken || !safeCompare(req.get("X-Updater-Token"), config.updaterControlToken)) {
      return res.status(401).json({ error: "Unauthorized" });
    }
    backupUpload.single("file")(req, res, async (error) => {
      if (error) return next(error);
      try {
        res.json({ restored: await restoreFromBuffer(req.file?.buffer) });
      } catch (restoreError) { next(restoreError); }
    });
  });

  app.use("/api/media", express.static(store.uploadsDir, {
    dotfiles: "deny",
    fallthrough: false,
    etag: true,
    maxAge: config.environment === "production" ? "1h" : 0,
    setHeaders(response, filename) {
      if (filename.toLowerCase().endsWith(".pdf")) response.setHeader("Content-Type", "application/pdf");
    },
  }));
  app.use("/vendor/pdfjs", express.static(path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "node_modules", "pdfjs-dist", "build"), {
    dotfiles: "deny",
    maxAge: config.environment === "production" ? "30d" : 0,
  }));

  app.get("/robots.txt", (req, res) => sendText(res, "text/plain; charset=utf-8", buildRobots(baseUrl(req))));
  if (config.indexNowKey) {
    app.get(`/${config.indexNowKey}.txt`, (_req, res) => sendText(res, "text/plain; charset=utf-8", `${config.indexNowKey}\n`, "public, max-age=86400"));
  }
  app.get("/sitemap-index.xml", async (req, res, next) => {
    try {
      const dates = await pageModifiedDates();
      const pageLatest = Object.values(dates).filter(Boolean).sort().at(-1) || null;
      setLastModified(res, pageLatest);
      sendText(res, "application/xml; charset=utf-8", buildSitemapIndex(baseUrl(req), publishedArticles(), pageLatest, dates.journal));
    } catch (error) { next(error); }
  });
  app.get("/sitemaps/pages-0001.xml", async (req, res, next) => {
    try {
      const dates = await pageModifiedDates();
      setLastModified(res, Object.values(dates).filter(Boolean).sort().at(-1));
      sendText(res, "application/xml; charset=utf-8", buildPagesSitemap(baseUrl(req), dates));
    }
    catch (error) { next(error); }
  });
  app.get(/^\/sitemaps\/articles-(\d{4})\.xml$/, (req, res) => {
    const shard = Number.parseInt(req.params[0], 10);
    if (shard < 1) return res.status(404).type("text/plain").send("Not found");
    const modified = contentModifiedAt(["site", "journal"]);
    setLastModified(res, modified);
    sendText(res, "application/xml; charset=utf-8", buildArticlesSitemap(baseUrl(req), publishedArticles(), shard));
  });
  app.get("/llms.txt", (req, res) => {
    setAgentLinks(req, res);
    setLastModified(res, contentModifiedAt(["site", "journal"]));
    sendText(res, "text/markdown; charset=utf-8", buildLlms(baseUrl(req), content(), publishedArticleDetails()));
  });
  app.get("/llms-full.txt", (req, res) => {
    res.setHeader("Deprecation", "true");
    res.setHeader("Link", `<${new URL("/llms.txt", `${baseUrl(req)}/`)}>; rel="successor-version"`);
    setLastModified(res, contentModifiedAt(["site", "journal"]));
    sendText(res, "text/markdown; charset=utf-8", buildLlms(baseUrl(req), content(), publishedArticleDetails(), { full: true }));
  });
  app.get("/feed.xml", (req, res) => {
    const articles = publishedArticleDetails();
    setLastModified(res, contentModifiedAt(["site", "journal"]));
    sendText(res, "application/rss+xml; charset=utf-8", buildFeed(baseUrl(req), content(), articles));
  });

  app.get("/index.md", (req, res) => {
    res.setHeader("X-Robots-Tag", "noindex, follow");
    res.setHeader("Content-Location", new URL("/index.md", `${baseUrl(req)}/`).toString());
    setAgentLinks(req, res, "", "/");
    setLastModified(res, contentModifiedAt(["site", "home"]));
    sendText(res, "text/markdown; charset=utf-8", agentCatalog.homeMarkdownDocument(baseUrl(req)));
  });
  app.get("/about.md", async (req, res, next) => {
    try {
      res.setHeader("X-Robots-Tag", "noindex, follow");
      res.setHeader("Content-Location", new URL("/about.md", `${baseUrl(req)}/`).toString());
      setAgentLinks(req, res, "", "/about");
      setLastModified(res, contentModifiedAt(["site", "about"]));
      sendText(res, "text/markdown; charset=utf-8", await agentCatalog.aboutMarkdownDocument(baseUrl(req)));
    } catch (error) { next(error); }
  });
  app.get("/journal.md", (req, res) => {
    res.setHeader("X-Robots-Tag", "noindex, follow");
    res.setHeader("Content-Location", new URL("/journal.md", `${baseUrl(req)}/`).toString());
    setAgentLinks(req, res, "", "/journal");
    setLastModified(res, contentModifiedAt(["site", "journal"]));
    sendText(res, "text/markdown; charset=utf-8", agentCatalog.journalMarkdownDocument(baseUrl(req)));
  });
  app.get(/^\/journal\/([^/]+)\.md$/, (req, res) => {
    const requested = decodeURIComponent(req.params[0]);
    const article = store.getArticle(requested);
    if (!article) {
      res.setHeader("X-Robots-Tag", "noindex, nofollow");
      const gone = store.library.getGoneUrl(requested);
      if (gone?.replacementSlug) return res.redirect(308, `/journal/${encodeURIComponent(gone.replacementSlug)}.md`);
      return res.status(gone ? 410 : 404).type("text/plain").send("Publication not found");
    }
    if (article.slug !== requested) return res.redirect(308, `/journal/${encodeURIComponent(article.slug)}.md`);
    const machine = agentCatalog.get(article.internalId, { baseUrl: baseUrl(req), include: ["content"] });
    res.setHeader("X-Robots-Tag", "noindex, follow");
    res.setHeader("Content-Location", new URL(`/journal/${encodeURIComponent(article.slug)}.md`, `${baseUrl(req)}/`).toString());
    setLastModified(res, contentModifiedAt(["site", "journal"], article.internalId));
    setAgentLinks(req, res, "", `/journal/${encodeURIComponent(article.slug)}`);
    sendText(res, "text/markdown; charset=utf-8", machine.contentMarkdown);
  });

  app.get("/", (req, res) => {
    setAgentLinks(req, res, "/index.md");
    setLastModified(res, contentModifiedAt(["site", "home"]));
    sendText(res, "text/html; charset=utf-8", renderHomePage(templates.get("index.html"), {
      content: content(), baseUrl: baseUrl(req), nonce: req.cspNonce, authorName: config.defaultAuthorName,
    }));
  });
  app.get("/about", async (req, res, next) => {
    try {
      setAgentLinks(req, res, "/about.md");
      setLastModified(res, contentModifiedAt(["site", "about"]));
      sendText(res, "text/html; charset=utf-8", renderAboutPage(templates.get("about.html"), {
        content: content(), about: await aboutPage(), baseUrl: baseUrl(req), nonce: req.cspNonce,
        authorName: config.defaultAuthorName,
      }));
    } catch (error) { next(error); }
  });
  app.get("/journal", (req, res) => {
    setAgentLinks(req, res, "/journal.md");
    setLastModified(res, contentModifiedAt(["site", "journal"]));
    sendText(res, "text/html; charset=utf-8", renderJournalPage(templates.get("journal.html"), {
      content: content(), articles: publishedArticles(), baseUrl: baseUrl(req), nonce: req.cspNonce,
      authorName: config.defaultAuthorName,
    }));
  });
  app.get(/^\/journal\/([^/]+)\/?$/, (req, res) => {
    const requested = decodeURIComponent(req.params[0]);
    const article = store.getArticle(requested);
    if (!article) {
      res.setHeader("X-Robots-Tag", "noindex, nofollow");
      const gone = store.library.getGoneUrl(requested);
      if (gone?.replacementSlug) return res.redirect(308, `/journal/${encodeURIComponent(gone.replacementSlug)}`);
      return res.status(gone ? 410 : 404).sendFile("404.html", { root: config.publicDir });
    }
    if (article.slug !== requested) return res.redirect(308, `/journal/${encodeURIComponent(article.slug)}`);
    setLastModified(res, contentModifiedAt(["site", "journal"], article.internalId));
    const remoteOrigins = article.files
      .filter((file) => file.storageBackend === "saturn" && file.publicUrl)
      .map((file) => new URL(file.publicUrl).origin);
    setAgentLinks(req, res, `/journal/${encodeURIComponent(article.slug)}.md`, "", remoteOrigins);
    sendText(res, "text/html; charset=utf-8", renderArticlePage(templates.get("article.html"), {
      content: content(), article, baseUrl: baseUrl(req), nonce: req.cspNonce, authorName: config.defaultAuthorName,
    }));
  });
  app.get("/private", (_req, res) => {
    res.setHeader("X-Robots-Tag", "noindex, nofollow, noarchive");
    res.setHeader("Cache-Control", "private, no-store");
    res.sendFile("admin.html", { root: config.publicDir });
  });
  app.get("/index.html", (_req, res) => res.redirect(308, "/"));
  app.get("/index", (_req, res) => res.redirect(308, "/"));
  app.get("/about.html", (_req, res) => res.redirect(308, "/about"));
  app.get("/journal.html", (_req, res) => res.redirect(308, "/journal"));
  app.get(["/article", "/article.html", "/404", "/404.html"], (_req, res) => {
    res.setHeader("X-Robots-Tag", "noindex, nofollow");
    res.status(404).sendFile("404.html", { root: config.publicDir });
  });
  app.get(["/admin", "/admin.html"], (_req, res) => {
    res.setHeader("X-Robots-Tag", "noindex, nofollow");
    res.status(404).sendFile("404.html", { root: config.publicDir });
  });
  app.use(express.static(config.publicDir, { etag: true }));

  app.use((req, res) => {
    if (req.path.startsWith("/api/")) return res.status(404).json({ error: "Not found" });
    res.setHeader("X-Robots-Tag", "noindex, nofollow");
    res.status(404).sendFile("404.html", { root: config.publicDir });
  });

  app.use((error, req, res, _next) => {
    const status = error.status || (error.code === "LIMIT_FILE_SIZE" ? 413 : 400);
    if (status >= 500 || config.environment !== "production") console.error(`[${req.requestId}]`, error);
    res.status(status).json({ error: error.message || "Request failed", requestId: req.requestId });
  });

  app.locals.laboratory = {
    config, store, register, updater, neptune, saturnLibrary, githubLibrary, derivedContent, searchNotifications, audit,
    evidenceIndex, agentCatalog,
  };
  return app;
}

export async function startServer(overrides = {}) {
  const app = await createLaboratoryApp(overrides);
  const config = app.locals.laboratory.config;
  const server = app.listen(config.port, "0.0.0.0", () => {
    console.log(`Laboratory listening on http://127.0.0.1:${config.port}`);
  });
  const shutdown = () => {
    server.close(() => {
      app.locals.laboratory.register.stop();
      app.locals.laboratory.githubLibrary.stop();
      app.locals.laboratory.derivedContent.stop();
      app.locals.laboratory.searchNotifications.stop();
      app.locals.laboratory.store.close();
      process.exit(0);
    });
    setTimeout(() => process.exit(1), 10_000).unref();
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  return { app, server };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  startServer().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
