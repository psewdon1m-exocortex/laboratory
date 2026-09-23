import { mountUpdateFlow } from "./update-flow.js";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import cookieParser from "cookie-parser";
import express from "express";
import multer from "multer";
import { createOperationBudget } from "./operation-budget.js";
import {
  LoginLimiter,
  authMiddleware,
  clearSessionCookie,
  createSession,
  credentialsMatch,
  setSessionCookie,
} from "./auth.js";
import { createBackup, MAX_ARCHIVE_BYTES, parseBackupAsync } from "./backup.js";
import { AgentCatalog } from "./agent-catalog.js";
import { AuditLog } from "./audit-log.js";
import { buildArticleArchive, MAX_ARTICLE_ARCHIVE_BYTES } from "./article-archive.js";
import { renderMarkdownDocument } from "./article-markdown.js";
import { loadConfig } from "./config.js";
import { DerivedContentRuntime } from "./derived-content.js";
import { intentFromStatus, saveIntent } from "./wyvern-intent.js";
import { EvidenceIndex } from "./evidence-index.js";
import { GitHubArticleLibrary } from "./github-library.js";
import { KernelRegisterRuntime, resolveKernelValues } from "./kernel-register.js";
import { loadKernelConnection, saveKernelConnection } from "./kernel-connection.js";
import { createBackupPolicy } from "./backup-policy.js";
import { createNeptuneClient } from "./neptune-client.js";
import { generateArticleOg } from "./og-image.js";
import { handleMcpRequest, mcpCors } from "./mcp.js";
import { FixedWindowRateLimiter, publicCors, registerPublicApi } from "./public-api.js";
import { PublicTelemetry, hasTelemetryConsent } from "./public-telemetry.js";
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
  await loadKernelConnection(config);
  const store = await LaboratoryStore.open(config);
  const storedAiPipeline = store.db.prepare("SELECT value FROM settings WHERE key = 'aiPipelineEnabled'").get();
  if (storedAiPipeline) config.derivedContentEnabled = storedAiPipeline.value === "true";
  const register = new KernelRegisterRuntime(config);
  await register.start();
  store.library.resolveSaturnOrigin = () => register.state.saturnUrl;
  const updater = new UpdaterClient(config);
  const neptune = createNeptuneClient(config);
  const backupPolicy = createBackupPolicy({
    client: neptune, configured: () => Boolean(config.neptuneControlTokenFile && fs.existsSync(config.neptuneControlTokenFile)),
    readPending: () => JSON.parse(store.db.prepare("SELECT value FROM settings WHERE key='backup_policy_restore'").get()?.value || "null"),
    writePending: value => store.db.prepare("INSERT INTO settings(key,value) VALUES ('backup_policy_restore',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(JSON.stringify(value)),
  });
  store.backupPolicy = backupPolicy;
  const saturnLibrary = new SaturnArticleBundleClient(config, register);
  const githubLibrary = new GitHubArticleLibrary(config, register, store.library, saturnLibrary);
  githubLibrary.start();
  const derivedContent = new DerivedContentRuntime(config, store.library, register);
  await derivedContent.start();
  const searchNotifications = new SearchNotificationRuntime(config, store.library, register);
  searchNotifications.start();
  const auth = authMiddleware(config, store.security);
  const audit = new AuditLog(config);
  await audit.initialize();
  const loginLimiter = new LoginLimiter();
  const archiveOperation = createOperationBudget();
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
  const defaultSocialImage = fs.readFileSync(path.join(config.publicDir, "og.png"));
  const defaultSocialImageHash = crypto.createHash("sha256").update(defaultSocialImage).digest("hex");
  const articleOgCache = new Map();
  const socialImageSource = async () => {
    const uploaded = await store.readAsset("socialImage");
    return uploaded ? { data: uploaded.data, sha256: uploaded.sha256 } : { data: defaultSocialImage, sha256: defaultSocialImageHash };
  };
  const articleOgVersion = (imageHash, siteTitle) => crypto.createHash("sha256").update(`${imageHash}:${siteTitle}`).digest("hex").slice(0, 16);
  const articleOgPath = (article, version) => `/og/articles/${article.internalId}/${article.revision}-${version}.png`;
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
  const publicTelemetry = new PublicTelemetry(store.db, { retentionDays: config.publicTelemetryRetentionDays });
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
    const parsed = await parseBackupAsync(buffer);
    const restored = await store.restoreSnapshot(parsed.snapshot, parsed.files);
    await derivedContent.loadSettings();
    return restored;
  };

  const app = express();
  if (config.trustProxy) app.set("trust proxy", config.trustedProxyAddresses);
  app.disable("x-powered-by");
  app.use(async (req, res, next) => {
    // Authentication and diagnostics remain reachable while discovery is down.
    // Every public representation that constructs links refreshes the authority first.
    const independent = /^\/(?:private(?:\/|$)|api\/(?:admin|health|live|ready|internal|updates|neptune)(?:\/|$)|scripts\/|styles\/|fonts\/)/.test(req.path);
    if (config.kernelUrl && !independent) {
      await register.refresh();
      if (register.error) return res.status(503).set("Cache-Control", "no-store").json({ error: "Service discovery is unavailable" });
    }
    next();
  });
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
    if (store.restoreInProgress && !["/api/health", "/api/live"].includes(req.path)) {
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
  for (const prefix of ["/api/admin", "/api/updates", "/api/neptune", "/api/security"]) {
    app.use(prefix, (_req, res, next) => {
      res.setHeader("Cache-Control", "private, no-store");
      next();
    });
  }
  const publicApiLimiter = new FixedWindowRateLimiter({ limit: config.publicApiRateLimit, windowMs: 60_000 });
  const mcpLimiter = new FixedWindowRateLimiter({ limit: config.mcpRateLimit, windowMs: 60_000 });
  const telemetryLimiter = new FixedWindowRateLimiter({ limit: config.publicTelemetryRateLimit, windowMs: 60_000 });
  app.use("/api/public", publicCors, publicApiLimiter.middleware(requestKey));
  app.use("/mcp", mcpCors({ publicUrl: config.publicUrl, allowedOrigins: config.mcpAllowedOrigins }), mcpLimiter.middleware(requestKey));

  app.post("/api/telemetry/collect", telemetryLimiter.middleware(requestKey), (req, res, next) => {
    try {
      res.setHeader("Cache-Control", "no-store");
      if (!hasTelemetryConsent(req)) return res.status(403).json({ error: "Telemetry consent is required" });
      const requestOrigin = req.get("Origin");
      if (requestOrigin && requestOrigin !== baseUrl(req)) return res.status(403).json({ error: "Invalid telemetry origin" });
      publicTelemetry.collect(req.body);
      res.status(204).end();
    } catch (error) { next(error); }
  });

  app.get("/api/live", (_req, res) => res.json({ status: "ok", service: "laboratory", level: "liveness" }));

  app.get("/api/health", (_req, res) => {
    let ready = !store.restoreInProgress && (!config.kernelUrl || Boolean(register.state.revision) && !register.error);
    try { store.db.prepare("SELECT 1").get(); } catch { ready = false; }
    res.status(ready ? 200 : 503).json({ status: ready ? "ok" : "unavailable", service: "laboratory", version: config.version, level: "core-readiness" });
  });

  app.get("/api/ready", auth.requireAdmin, async (_req, res) => {
    await register.refresh();
    const agents = await Promise.allSettled([updater.status(), neptune.status()]);
    const checks = { kernel: Boolean(register.state.revision) && !register.error, storage: !store.restoreInProgress,
      updater: agents[0].status === "fulfilled" && agents[0].value.available,
      neptune: agents[1].status === "fulfilled", github: Boolean(register.state.githubToken && register.state.githubWebhookSecret),
      saturn: Boolean(register.state.saturnUrl && register.state.saturnClientToken) };
    const ready = Object.values(checks).every(Boolean);
    res.setHeader("Cache-Control", "private, no-store");
    res.status(ready ? 200 : 503).json({ ready, checks, llm_ready: (await derivedContent.gateway.status()).llm_ready, external_delivery_verified: false });
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
      const accessKey = req.body?.access_key ?? req.body?.accessKey ?? req.body?.password;
      if (!store.security.verify(accessKey)) {
        return res.status(401).json({ error: "Invalid credentials" });
      }
      loginLimiter.clear(key);
      const session = createSession(config.adminUsername, config.sessionSecret, store.security.generation());
      setSessionCookie(res, session.token, config);
      res.json({ authenticated: true, username: config.adminUsername, csrfToken: session.csrf });
    } catch (error) {
      next(error);
    }
  });

  app.get("/api/admin/session", auth.requireAdmin, (req, res) => {
    res.json({ authenticated: true, username: config.adminUsername, csrfToken: req.adminSession.csrf });
  });

  app.post("/api/admin/logout", auth.requireMutation, (req, res) => {
    store.security.revoke(req.cookies.laboratory_session, req.adminSession.exp);
    clearSessionCookie(res, config);
    res.json({ authenticated: false });
  });

  app.put("/api/admin/security/access-key", auth.requireMutation, (req, res, next) => {
    try {
      loginLimiter.check(`rotate:${requestKey(req)}`);
      if (!store.security.verify(req.body?.current_access_key)) return res.status(401).json({ error: "Invalid current Access Key" });
      if (req.body?.new_access_key !== req.body?.confirm_access_key) return res.status(400).json({ error: "Access Keys do not match" });
      store.security.rotate(req.body.new_access_key);
      loginLimiter.clear(`rotate:${requestKey(req)}`);
      const session = createSession(config.adminUsername, config.sessionSecret, store.security.generation());
      setSessionCookie(res, session.token, config);
      res.json({ authenticated: true, csrfToken: session.csrf });
    } catch (error) { next(error); }
  });

  app.get("/api/admin/state", auth.requireAdmin, async (_req, res) => {
    res.json({
      content: store.getContent(),
      articles: store.listArticles({ includeDrafts: true }),
      runtime: {
        version: config.version,
        kernelUrl: config.kernelUrl,
        registerRevision: register.state.revision,
        registerError: register.error,
        repositoryUrl: register.state.repositoryUrl,
        contentLibrary: githubLibrary.status(),
        derivedContent: derivedContent.status(),
        searchNotifications: searchNotifications.status(),
        publicTelemetry: publicTelemetry.status(),
        publicUrl: register.state.publicUrl,
        updater: await updater.status(),
      },
    });
  });

  app.get("/api/admin/search-notifications", auth.requireAdmin, (_req, res) => {
    res.json(searchNotifications.status());
  });

  app.post("/api/admin/search-notifications/run", auth.requireMutation, async (_req, res, next) => {
    try { res.json(await searchNotifications.runNow()); }
    catch (error) { next(error); }
  });

  app.put("/api/admin/security/kernel", auth.requireMutation, async (req, res, next) => {
    try {
      const url = new URL(String(req.body?.url || ""));
      if (url.protocol !== "https:" || url.username || url.password || url.pathname !== "/" || url.search || url.hash) return res.status(400).json({ error: "Kernel requires an HTTPS origin" });
      const token = String(req.body?.token || config.kernelServiceToken);
      if (token.length < 24 || token.length > 4096 || /[\r\n\0]/.test(token) || req.body?.token && token !== req.body?.confirm_token) return res.status(400).json({ error: "Invalid or mismatched Kernel token" });
      const candidate = new KernelRegisterRuntime({ ...config, kernelUrl: url.origin, kernelServiceToken: token, kernelCachePath: config.kernelCachePath + ".candidate" });
      try {
        await candidate.refresh();
        if (candidate.error || !candidate.state.revision) return res.status(409).json({ error: "Kernel connection or deployment profile validation failed" });
        await saveKernelConnection(config, url.origin, token);
        Object.assign(config, { kernelUrl: url.origin, kernelServiceToken: token });
        await register.refresh();
        res.json({ kernelUrl: config.kernelUrl, reachable: !register.error });
      } finally { await fs.promises.rm(config.kernelCachePath + ".candidate", { force: true }); }
    } catch (error) { next(error); }
  });

  app.get("/api/admin/telemetry", auth.requireAdmin, async (_req, res, next) => {
    try { const disk = await fs.promises.statfs(config.dataDir); res.json({ uptime_seconds: process.uptime(), memory: process.memoryUsage(), disk: { total_bytes: disk.blocks * disk.bsize, available_bytes: disk.bavail * disk.bsize, used_bytes: (disk.blocks - disk.bavail) * disk.bsize } }); }
    catch (error) { next(error); }
  });

  app.get("/api/admin/documentation", auth.requireAdmin, (_req, res) => res.json({ sections: [
    { title: "Security", body: "Sign in with the Access Key. Rotation revokes other sessions. Kernel tokens are write-only and validated before replacement." },
    { title: "Recovery", body: "ZIP archives include content, settings, revisions, queues, the Access Key verifier and non-secret Wyvern binding choices. Restore replaces application state and signs out all sessions. Target machine enrollment remains in place. Restored Wyvern choices await matching bindings or explicit selection in Settings; restore never changes the shared gateway." },
    { title: "Connections", body: "Kernel resolves current service origins. Wyvern holds provider credentials and executes requests through the selected Adapter. Initialize Neptune with a setup code from Saturn. Schedules and remote backup runs are managed in Saturn → Synchronization." },
    { title: "Updates", body: "Updater checks scoped signed releases, makes a recovery archive and verifies health after replacement. Monitor the job until it reaches a terminal state." },
    { title: "Part 12: deployment checks", body: "Check core readiness, enrollment, last seen and last successful backup separately. Unknown or stale does not mean zero. After a change verify public DNS/TLS, authenticated integrations and a downloaded-backup restore. Keep the job ID and redacted logs when investigating a failure; never include access keys or tokens." }
  ] }));

  app.put("/api/admin/content", auth.requireMutation, (req, res, next) => {
    try { res.json(store.updateContent(req.body ?? {})); }
    catch (error) { next(error); }
  });

  app.get("/api/admin/wyvern", auth.requireAdmin, async (_req, res) => res.json(await derivedContent.gateway.status()));
  app.get("/api/admin/wyvern/management", auth.requireAdmin, async (_req, res) => {
    const key = "services.wyvern.management_url";
    let record;
    try { record = (await resolveKernelValues(config, [key]))[key]; }
    catch { return res.status(503).json({ error: "An authorized gateway management destination is not available in Kernel." }); }
    if (record?.secret !== false) return res.status(409).json({ error: "The management destination must be a public Register value." });
    const url = new URL(record.value);
    if (url.protocol !== "https:" || url.username || url.password) return res.status(409).json({ error: "Invalid gateway management destination." });
    return res.json({ url: url.href });
  });
  app.post("/api/admin/wyvern/bindings", auth.requireMutation, async (req, res, next) => {
    try {
      if (!req.body || Object.keys(req.body).sort().join(",") !== "bindings,expected_revision,request_id") throw new Error("Provide function bindings and the current revision");
      const result = await derivedContent.gateway.call("POST", "/v1/bindings", { data: req.body });
      saveIntent(store.db, intentFromStatus(result));
      res.json(result);
    } catch (error) { next(error); }
  });
  app.post("/api/admin/wyvern/connect", auth.requireMutation, async (req, res, next) => {
    try {
      if (Object.keys(req.body || {}).join(",") !== "request_id" || !/^[0-9a-f-]{36}$/i.test(req.body.request_id)) return res.status(400).json({ error: "Provide a stable initialization request ID. The service identity is derived on the server." });
      res.status(202).json(await updater.request("POST", "/v1/lifecycle/wyvern-installation", { head_id: config.updaterHeadId, request_id: req.body.request_id }, true));
    } catch (error) { next(error); }
  });
  app.get("/api/admin/ai", auth.requireAdmin, async (_req, res) => {
    await derivedContent.gateway.status();
    res.json(derivedContent.settings());
  });

  app.put("/api/admin/ai", auth.requireMutation, async (req, res, next) => {
    const previous = config.derivedContentEnabled;
    try {
      const enabled = req.body?.enabled;
      if (enabled === true && !previous) {
        config.derivedContentEnabled = true;
        if (!(await derivedContent.gateway.status()).llm_ready) throw new Error("Select a ready Wyvern Adapter in Settings");
      }
      res.json(derivedContent.configure({ enabled, prompt: req.body?.prompt }));
    } catch (error) {
      config.derivedContentEnabled = previous;
      next(error);
    }
  });

  app.post("/api/admin/upload/:slot", auth.requireMutation, archiveOperation(async (req, res, next) => {
    const slot = req.params.slot;
    if (!UPLOAD_SLOTS[slot]) return res.status(400).json({ error: "Unknown upload slot" });
      try { res.json(await store.saveAsset(slot, req.file)); }
      catch (uploadError) { next(uploadError); }
  }, upload.single("file")));

  app.delete("/api/admin/upload/:slot", auth.requireMutation, async (req, res, next) => {
    try { res.json(await store.removeAsset(req.params.slot)); }
    catch (error) { next(error); }
  });

  app.get("/api/admin/articles/:id", auth.requireAdmin, (req, res) => {
    const article = store.library.getAdminArticle(req.params.id);
    if (!article) return res.status(404).json({ error: "Article not found" });
    res.json(article);
  });

  app.get("/api/admin/articles/:id/archive", auth.requireAdmin, archiveOperation(async (req, res, next) => {
    try {
      const article = store.library.getAdminArticle(req.params.id);
      if (!article) return res.status(404).json({ error: "Article not found" });
      const archive = await store.library.exportArchive(req.params.id);
      res.setHeader("Content-Type", "application/zip");
      res.setHeader("Content-Disposition", `attachment; filename*=UTF-8''${encodeURIComponent(`${article.title}.zip`)}`);
      res.send(archive);
    } catch (error) { next(error); }
  }));

  app.post("/api/admin/articles/import", auth.requireMutation, archiveOperation(async (req, res, next) => {
      try {
        if (!req.file?.buffer?.length) throw new Error("Article file is required");
        const originalName = String(req.file.originalname || "article.zip");
        const markdown = /\.md$/i.test(originalName);
        const archive = markdown
          ? buildArticleArchive({ files: [{ path: "article.md", bytes: req.file.buffer }] })
          : req.file.buffer;
        const result = await store.library.importArchive(archive, {
          archiveName: markdown ? `${path.basename(originalName, path.extname(originalName))}.zip` : originalName,
          title: req.body?.title || (markdown ? path.basename(originalName, path.extname(originalName)) : undefined),
          status: req.body?.status || "published",
          sourceKind: "admin",
        });
        const writeback = await githubLibrary.writeArticle(result);
        res.status(result.changed ? 201 : 200).json({ ...result, archive: undefined, writeback });
      } catch (importError) { next(importError); }
  }, articleUpload.single("file")));

  app.put("/api/admin/articles/:id", auth.requireMutation, async (req, res, next) => {
    try {
      const result = await store.library.revise(req.params.id, req.body || {});
      const writeback = await githubLibrary.writeArticle(result);
      res.json({ ...result, archive: undefined, writeback });
    } catch (error) { next(error); }
  });

  app.post("/api/admin/articles/:id/derivatives/regenerate", auth.requireMutation, async (req, res, next) => {
    try { await derivedContent.gateway.status(); res.status(202).json(derivedContent.regenerate(req.params.id)); }
    catch (error) { next(error); }
  });

  app.post("/api/admin/articles/:id/main", auth.requireMutation, archiveOperation(async (req, res, next) => {
      try {
        const result = await store.library.replaceMain(req.params.id, req.file, req.body || {});
        const writeback = await githubLibrary.writeArticle(result);
        res.json({ ...result, archive: undefined, writeback });
      } catch (replaceError) { next(replaceError); }
  }, articleUpload.single("file")));

  app.post("/api/admin/articles/:id/files/:folder", auth.requireMutation, archiveOperation(async (req, res, next) => {
      try {
        const result = await store.library.addFile(req.params.id, req.params.folder, req.file);
        const writeback = await githubLibrary.writeArticle(result);
        res.json({ ...result, archive: undefined, writeback });
      } catch (fileError) { next(fileError); }
  }, articleUpload.single("file")));

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

  app.get("/api/admin/backup", auth.requireAdmin, archiveOperation(async (_req, res, next) => {
    try {
      const archive = await createBackup(store, config.version);
      const stamp = new Date().toISOString().replace(/[-:TZ.]/g, "").slice(0, 14);
      res.setHeader("Content-Type", "application/zip");
      res.setHeader("Content-Disposition", `attachment; filename="laboratory-backup-${stamp}.zip"`);
      res.send(archive);
    } catch (error) { next(error); }
  }));

  app.head("/api/internal/neptune/backup", (req, res, next) => {
    try {
      if (!config.neptuneExportTokenFile || !fs.existsSync(config.neptuneExportTokenFile)
        || !safeCompare(req.get("Authorization"), `Bearer ${fs.readFileSync(config.neptuneExportTokenFile, "utf8").trim()}`)) {
        return res.status(401).json({ error: "Unauthorized" });
      }
      if (store.restoreInProgress) return res.status(503).end();
      store.db.prepare("SELECT 1").get();
      return res.set("X-Neptune-Ready", "1").status(204).end();
    } catch (error) { next(error); }
  });
  app.get("/api/neptune/availability", auth.requireAdmin, async (_req, res) => res.json(await neptune.availability()));
  app.get("/api/neptune/policy", auth.requireAdmin, async (_req, res) => res.json(await backupPolicy.read()));
  app.put("/api/neptune/policy", auth.requireMutation, async (req, res) => res.json(await backupPolicy.mutate(req.body)));
  app.get("/api/neptune/policy/runs", auth.requireAdmin, async (_req, res) => res.json(await backupPolicy.runs()));
  app.post("/api/neptune/policy/runs", auth.requireMutation, async (req, res) => res.status(202).json(await backupPolicy.runs("POST", req.body)));

  app.post("/api/internal/neptune/backup", async (req, res, next) => {
    try {
      if (!config.neptuneExportTokenFile || !fs.existsSync(config.neptuneExportTokenFile)
        || !safeCompare(req.get("Authorization"), `Bearer ${fs.readFileSync(config.neptuneExportTokenFile, "utf8").trim()}`)) {
        return res.status(401).json({ error: "Unauthorized" });
      }
      backupPolicy.assertExportReady();
      return archiveOperation(async (_req, res) => {
      const archive = await createBackup(store, config.version);
      const checksum = crypto.createHash("sha256").update(archive).digest("hex");
      res.setHeader("Content-Type", "application/zip");
      res.setHeader("Content-Length", String(archive.length));
      res.setHeader("X-Neptune-Archive-Sha256", checksum);
      res.setHeader("X-Neptune-Source-Version", config.version);
      res.send(archive);
      })(req, res, next);
    } catch (error) { next(error); }
  });

  app.get("/api/neptune/status", auth.requireAdmin, async (_req, res, next) => {
    try { res.json(await neptune.status()); } catch (error) { next(error); }
  });

  app.put("/api/neptune/schedule", auth.requireMutation, (_req, res) => res.status(426).json({ error: "Use the versioned service backup policy" }));
  app.post("/api/neptune/runs", auth.requireMutation, (_req, res) => res.status(426).json({ error: "Use the versioned service backup run endpoint" }));
  app.post("/api/neptune/initialize", auth.requireMutation, async (req, res, next) => {
    try {
      const code = String(req.body?.enrollment_code || "");
      if (!/^[A-Za-z0-9_-]{32}$/.test(code)) return res.status(400).json({ error: "Enter the 32-character Saturn setup code" });
      res.status(202).json(await updater.initializeNeptune(code, "http://127.0.0.1:" + config.port + "/api/internal/neptune/backup", req.body?.request_id));
    } catch (error) { next(error); }
  });
  app.post("/api/updates/agent/install", auth.requireMutation, async (_req, res, next) => {
    try { res.status(202).json(await updater.updateSelf()); } catch (error) { next(error); }
  });

  app.post("/api/neptune/update/check", auth.requireMutation, async (_req, res, next) => {
    try {
      const status = await neptune.status();
      res.json(await updater.checkNeptune(status.version));
    } catch (error) { next(error); }
  });

  app.post("/api/neptune/update/install", auth.requireMutation, async (req, res, next) => {
    try {
      const requestedVersion = String(req.body?.version ?? "");
      const status = await neptune.status();
      const update = await updater.checkNeptune(status.version);
      if (!update.update_available || update.available_version !== requestedVersion) {
        return res.status(409).json({ error: "Requested Neptune version is not the current upgrade candidate" });
      }
      res.json(await updater.updateNeptune(requestedVersion));
    } catch (error) { next(error); }
  });

  app.get("/api/admin/audit", auth.requireAdmin, async (req, res, next) => {
    try {
      const before = req.query.before_id;
      if (before !== undefined && (typeof before !== "string" || !/^[0-9a-f]{64}$/.test(before))) return res.status(400).json({ error: "Invalid log cursor" });
      res.json({ events: await audit.list(Number.parseInt(req.query.limit, 10) || 200, before ?? null) });
    }
    catch (error) { next(error); }
  });

  app.get("/api/admin/audit/export", auth.requireAdmin, archiveOperation(async (_req, res, next) => {
    try {
      const stamp = new Date().toISOString().replace(/[-:TZ.]/g, "").slice(0, 14);
      res.setHeader("Content-Type", "application/zip");
      res.setHeader("Content-Disposition", `attachment; filename="laboratory-audit-${stamp}.zip"`);
      res.setHeader("Cache-Control", "private, no-store");
      res.send(await audit.exportZip());
    } catch (error) { next(error); }
  }));

  app.post("/api/admin/restore/inspect", auth.requireMutation, archiveOperation(async (req, res, next) => {
    try {
      const parsed = await parseBackupAsync(req.file?.buffer);
      res.setHeader("Cache-Control", "private, no-store");
      res.json({ schema: parsed.manifest.schema, component: "laboratory", version: parsed.manifest.version,
        createdAt: parsed.manifest.createdAt, sizeBytes: req.file.buffer.length,
        sha256: crypto.createHash("sha256").update(req.file.buffer).digest("hex") });
    } catch (error) { next(error); }
  }, backupUpload.single("file")));

  app.post("/api/admin/restore", auth.requireMutation, archiveOperation(async (req, res, next) => {
      try {
        const expected = req.get("X-Backup-SHA256");
        if (expected && (!/^[a-f0-9]{64}$/.test(expected) || !req.file?.buffer
          || crypto.createHash("sha256").update(req.file.buffer).digest("hex") !== expected)) {
          return res.status(400).json({ error: "The archive does not match the inspected snapshot" });
        }
        const restored = await restoreFromBuffer(req.file?.buffer);
        clearSessionCookie(res, config);
        res.json({ restored, reauthenticate: true });
      } catch (restoreError) { next(restoreError); }
  }, backupUpload.single("file")));

  app.get("/api/updates/status", auth.requireAdmin, async (_req, res) => {
    res.json({ installedVersion: config.version, repositoryUrl: register.state.repositoryUrl, updater: await updater.status() });
  });

  app.post("/api/updates/check", auth.requireMutation, async (_req, res, next) => {
    try { await register.refresh(); if (register.error) throw new Error(register.error); res.json(await checkGithubRelease(register.state.repositoryUrl, config.version)); }
    catch (error) { next(error); }
  });

  mountUpdateFlow(app, { prefix: "/api/update-flow", service: "laboratory", helpers: ["updater", "neptune", "wyvern"], authorize: auth.requireAdmin, mutation: [auth.requireMutation],
    headId: config.updaterHeadId, token: () => config.updaterControlToken,
    client: { status: () => updater.status(), request: (method, route, body) => updater.request(method, route, body, true, 90_000) },
    backupGuard: archiveOperation,
    buildBackup: async () => ({ archive: await createBackup(store, config.version), filename: `laboratory-${new Date().toISOString().replaceAll(":", "-")}.zip` }),
  });
  app.post("/api/updates/apply", auth.requireMutation, (_req, res) => res.status(426).json({error: "Use the Updates dialog to save and return the same pre-update ZIP"}));

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
    return archiveOperation(async (req, res) => {
      try {
        res.json({ restored: await restoreFromBuffer(req.file?.buffer) });
      } catch (restoreError) { next(restoreError); }
    }, backupUpload.single("file"))(req, res, next);
  });

  app.get("/favicon.png", async (_req, res, next) => {
    try {
      const icon = await store.readAsset("webIcon");
      res.setHeader("Cache-Control", "public, max-age=0, must-revalidate");
      if (!icon) return res.sendFile("favicon.png", { root: config.publicDir });
      res.type(icon.mime).send(icon.data);
    } catch (error) { next(error); }
  });

  app.get("/og.png", async (_req, res, next) => {
    try {
      const image = await store.readAsset("socialImage");
      res.setHeader("Cache-Control", "public, max-age=0, must-revalidate");
      if (!image) return res.sendFile("og.png", { root: config.publicDir });
      res.type(image.mime).send(image.data);
    } catch (error) { next(error); }
  });

  app.get(/^\/og\/articles\/(l-[0-9A-HJKMNP-TV-Z]{12})\/(\d+)-([a-f0-9]{16})\.png$/, async (req, res, next) => {
    try {
      const article = store.getArticle(req.params[0]);
      if (!article || article.revision !== Number(req.params[1])) return res.status(404).end();
      const source = await socialImageSource();
      const siteTitle = content().siteTitle;
      const version = articleOgVersion(source.sha256, siteTitle);
      if (version !== req.params[2]) return res.status(404).end();
      const cacheKey = `${article.internalId}:${article.revision}:${version}`;
      let image = articleOgCache.get(cacheKey);
      if (!image) {
        image = await generateArticleOg({
          background: source.data,
          title: article.title,
          siteTitle,
          publishedAt: article.publishedAt,
          articleId: article.internalId,
        });
        if (articleOgCache.size >= 64) articleOgCache.delete(articleOgCache.keys().next().value);
        articleOgCache.set(cacheKey, image);
      }
      res.setHeader("Content-Type", "image/png");
      res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
      res.setHeader("ETag", `"${crypto.createHash("sha256").update(image).digest("base64url")}"`);
      res.send(image);
    } catch (error) { next(error); }
  });

  app.use("/api/media", (req, res, next) => {
    let relative;
    try { relative = decodeURIComponent(req.path).replace(/^\/+/, ""); }
    catch { return res.status(400).end(); }
    if (relative.startsWith("library/")) {
      const authenticated = Boolean(auth.session(req));
      if (!store.library.canReadStoragePath(relative.slice("library/".length), authenticated)) return res.status(404).end();
      if (authenticated) res.setHeader("Cache-Control", "private, no-store");
    }
    next();
  }, express.static(store.uploadsDir, {
    dotfiles: "deny",
    fallthrough: false,
    etag: true,
    maxAge: config.environment === "production" ? "1h" : 0,
    setHeaders(response, filename) {
      if (filename.startsWith(store.library.rootDir + path.sep)) response.setHeader("Cache-Control", "private, no-store");
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
  app.get(/^\/journal\/([^/]+)\/?$/, async (req, res, next) => {
    try {
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
      const socialSource = await socialImageSource();
      const socialVersion = articleOgVersion(socialSource.sha256, content().siteTitle);
      sendText(res, "text/html; charset=utf-8", renderArticlePage(templates.get("article.html"), {
        content: content(), article, baseUrl: baseUrl(req), nonce: req.cspNonce, authorName: config.defaultAuthorName,
        socialImagePath: articleOgPath(article, socialVersion),
      }));
    } catch (error) { next(error); }
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
    evidenceIndex, agentCatalog, publicTelemetry,
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
    server.close(async () => {
      app.locals.laboratory.register.stop();
      app.locals.laboratory.githubLibrary.stop();
      app.locals.laboratory.derivedContent.stop();
      app.locals.laboratory.searchNotifications.stop();
      await app.locals.laboratory.audit.queue;
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
