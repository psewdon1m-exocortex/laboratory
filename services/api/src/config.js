import path from "node:path";
import { fileURLToPath } from "node:url";

const API_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const PROJECT_ROOT = path.resolve(API_ROOT, "../..");

function integer(name, fallback, minimum = 1) {
  const value = Number.parseInt(process.env[name] ?? "", 10);
  return Number.isFinite(value) && value >= minimum ? value : fallback;
}

function boolean(name, fallback = false) {
  const value = process.env[name];
  if (value == null || value === "") return fallback;
  return value === "true";
}

function binarySwitch(name, fallback = false) {
  const value = process.env[name];
  if (value == null || value === "") return fallback;
  if (value === "1") return true;
  if (value === "0") return false;
  throw new Error(`Invalid Laboratory configuration: ${name} must be 0 or 1`);
}

export function loadConfig(overrides = {}) {
  const dataDir = path.resolve(
    overrides.dataDir
      ?? process.env.LABORATORY_DATA_DIR
      ?? path.join(PROJECT_ROOT, "data", "runtime"),
  );
  const serviceAccountBase64 = (process.env.LABORATORY_GOOGLE_SERVICE_ACCOUNT_BASE64 ?? "").trim();
  let googleServiceAccountCredentials = null;
  let googleServiceAccountError = "";
  if (serviceAccountBase64) {
    try {
      googleServiceAccountCredentials = JSON.parse(Buffer.from(serviceAccountBase64, "base64").toString("utf8"));
    } catch {
      googleServiceAccountError = "LABORATORY_GOOGLE_SERVICE_ACCOUNT_BASE64 must be base64-encoded service-account JSON";
    }
  }
  const config = {
    port: integer("LABORATORY_LISTEN_PORT", 18380),
    version: process.env.LABORATORY_VERSION ?? "0.1.0",
    environment: process.env.NODE_ENV ?? "development",
    dataDir,
    defaultsDir: path.resolve(
      process.env.LABORATORY_DEFAULTS_DIR ?? path.join(PROJECT_ROOT, "data", "defaults"),
    ),
    publicDir: path.join(PROJECT_ROOT, "services", "web", "static"),
    adminUsername: process.env.LABORATORY_ADMIN_USERNAME ?? "operator",
    adminPassword: process.env.LABORATORY_ADMIN_PASSWORD ?? "laboratory-local",
    sessionSecret:
      process.env.LABORATORY_SESSION_SECRET
      ?? "laboratory-local-session-secret-change-before-production",
    cookieSecure: boolean("LABORATORY_COOKIE_SECURE", false),
    trustProxy: boolean("LABORATORY_TRUST_PROXY", false),
    kernelUrl: (process.env.KERNEL_URL ?? "").trim(),
    kernelServiceToken: (process.env.KERNEL_SERVICE_TOKEN ?? "").trim(),
    kernelCachePath: path.resolve(
      process.env.KERNEL_CACHE_PATH
      ?? path.join(dataDir, "kernel-cache", "register.snapshot.json"),
    ),
    kernelTimeoutMs: integer("KERNEL_TIMEOUT_SEC", 3) * 1000,
    kernelRefreshSeconds: integer("KERNEL_REFRESH_SEC", 60, 5),
    repositoryUrl: (process.env.LABORATORY_REPOSITORY_URL ?? "").trim(),
    githubToken: (process.env.LABORATORY_CONTENT_GITHUB_TOKEN ?? "").trim(),
    githubWebhookSecret: (process.env.LABORATORY_CONTENT_WEBHOOK_SECRET ?? "").trim(),
    githubApiUrl: (process.env.LABORATORY_GITHUB_API_URL ?? "https://api.github.com").replace(/\/$/, ""),
    githubTimeoutMs: integer("LABORATORY_GITHUB_TIMEOUT_SEC", 15) * 1000,
    saturnUrl: (process.env.LABORATORY_SATURN_URL ?? "").trim().replace(/\/$/, ""),
    saturnTimeoutMs: integer("LABORATORY_SATURN_TIMEOUT_SEC", 30) * 1000,
    saturnClientToken: (process.env.LABORATORY_SATURN_CLIENT_TOKEN ?? "").trim(),
    localAssetMaxBytes: integer("LABORATORY_LOCAL_ASSET_MAX_BYTES", 10 * 1024 * 1024, 1),
    githubImportIntervalSeconds: integer("LABORATORY_GITHUB_IMPORT_INTERVAL_SEC", 5, 1),
    githubImportMaxAttempts: integer("LABORATORY_GITHUB_IMPORT_MAX_ATTEMPTS", 5, 1),
    publicUrl: (process.env.LABORATORY_PUBLIC_URL ?? "").trim(),
    defaultLanguage: (process.env.LABORATORY_DEFAULT_LANGUAGE ?? "en").trim(),
    defaultAuthorName: (process.env.LABORATORY_DEFAULT_AUTHOR_NAME ?? "c31e1b26").trim(),
    geminiModel: (process.env.LABORATORY_GEMINI_MODEL ?? "gemini-2.5-flash").trim(),
    geminiMaxOutputTokens: integer("LABORATORY_GEMINI_MAX_OUTPUT_TOKENS", 8_192, 1_024),
    geminiThinkingBudget: integer("LABORATORY_GEMINI_THINKING_BUDGET", 0, 0),
    derivedContentEnabled: binarySwitch("LABORATORY_AI_PIPELINE_ENABLED", true),
    derivedContentIntervalSeconds: integer("LABORATORY_DERIVED_CONTENT_INTERVAL_SEC", 15, 5),
    derivedContentMaxAttempts: integer("LABORATORY_DERIVED_CONTENT_MAX_ATTEMPTS", 3, 1),
    indexNowKey: (process.env.LABORATORY_INDEXNOW_KEY ?? "").trim(),
    indexNowEnabled: boolean("LABORATORY_INDEXNOW_ENABLED", Boolean((process.env.LABORATORY_INDEXNOW_KEY ?? "").trim())),
    indexNowEndpoint: (process.env.LABORATORY_INDEXNOW_ENDPOINT ?? "https://api.indexnow.org/indexnow").trim(),
    googleIndexingExperimentEnabled: boolean("LABORATORY_GOOGLE_INDEXING_EXPERIMENT_ENABLED", false),
    googleIndexingExperimentEndDate: (process.env.LABORATORY_GOOGLE_INDEXING_EXPERIMENT_END_DATE ?? "").trim(),
    googleIndexingExperimentMaxUrlsPerDay: integer("LABORATORY_GOOGLE_INDEXING_EXPERIMENT_MAX_URLS_PER_DAY", 1, 1),
    googleIndexingExperimentSamplePercent: integer("LABORATORY_GOOGLE_INDEXING_EXPERIMENT_SAMPLE_PERCENT", 50, 1),
    googleServiceAccountCredentials,
    googleServiceAccountError,
    searchNotificationIntervalSeconds: integer("LABORATORY_SEARCH_NOTIFICATION_INTERVAL_SEC", 30, 5),
    searchNotificationTimeoutMs: integer("LABORATORY_SEARCH_NOTIFICATION_TIMEOUT_SEC", 15, 1) * 1000,
    publicApiRateLimit: integer("LABORATORY_PUBLIC_API_RATE_LIMIT", 120, 10),
    mcpRateLimit: integer("LABORATORY_MCP_RATE_LIMIT", 60, 10),
    updaterSocketPath:
      process.env.UPDATER_SOCKET_PATH ?? "/run/exocortex/updater.sock",
    updaterHeadId: process.env.UPDATER_HEAD_ID ?? "laboratory",
    updaterControlToken: process.env.UPDATER_CONTROL_TOKEN ?? "",
    neptuneSocketPath: process.env.NEPTUNE_SOCKET_PATH ?? "/run/neptune/neptuned.sock",
    neptuneProjectId: process.env.NEPTUNE_PROJECT_ID ?? "laboratory",
    neptuneControlTokenFile: process.env.NEPTUNE_CONTROL_TOKEN_FILE ?? "/run/secrets/neptune/control.token",
    neptuneExportTokenFile: process.env.NEPTUNE_EXPORT_TOKEN_FILE ?? "/run/secrets/neptune/export.token",
    maxUploadBytes: integer("LABORATORY_MAX_UPLOAD_BYTES", 120 * 1024 * 1024),
    ...overrides,
  };
  validateConfig(config);
  return config;
}

function validateConfig(config) {
  const issues = [];
  if (!/^[A-Za-z0-9._-]{3,64}$/.test(config.adminUsername)) {
    issues.push("LABORATORY_ADMIN_USERNAME must contain 3-64 safe characters");
  }
  if (config.adminPassword.length < 12) {
    issues.push("LABORATORY_ADMIN_PASSWORD must contain at least 12 characters");
  }
  if (config.sessionSecret.length < 32) {
    issues.push("LABORATORY_SESSION_SECRET must contain at least 32 characters");
  }
  if (Boolean(config.kernelUrl) !== Boolean(config.kernelServiceToken)) {
    issues.push("KERNEL_URL and KERNEL_SERVICE_TOKEN must be configured together");
  }
  if (!/^[a-z]{2}(?:-[A-Z]{2})?$/.test(config.defaultLanguage)) {
    issues.push("LABORATORY_DEFAULT_LANGUAGE must be a language code such as en or en-US");
  }
  if (config.defaultAuthorName.length > 120) {
    issues.push("LABORATORY_DEFAULT_AUTHOR_NAME must contain at most 120 characters");
  }
  if (!/^[A-Za-z0-9._/-]{3,120}$/.test(config.geminiModel)) {
    issues.push("LABORATORY_GEMINI_MODEL is invalid");
  }
  if (config.indexNowEnabled && !/^[A-Za-z0-9-]{8,128}$/.test(config.indexNowKey)) {
    issues.push("LABORATORY_INDEXNOW_KEY must contain 8-128 alphanumeric or hyphen characters");
  }
  try { new URL(config.indexNowEndpoint); } catch { issues.push("LABORATORY_INDEXNOW_ENDPOINT must be an absolute URL"); }
  if (config.googleIndexingExperimentSamplePercent > 100) {
    issues.push("LABORATORY_GOOGLE_INDEXING_EXPERIMENT_SAMPLE_PERCENT must be at most 100");
  }
  if (config.googleIndexingExperimentEnabled && !/^\d{4}-\d{2}-\d{2}$/.test(config.googleIndexingExperimentEndDate)) {
    issues.push("LABORATORY_GOOGLE_INDEXING_EXPERIMENT_END_DATE is required as YYYY-MM-DD when the experiment is enabled");
  }
  if (config.googleServiceAccountError) issues.push(config.googleServiceAccountError);
  if (config.environment === "production") {
    if (!config.cookieSecure) issues.push("LABORATORY_COOKIE_SECURE must be true in production");
    if (["laboratory-local", "change_me", "CHANGE_ME"].some((part) =>
      config.adminPassword.includes(part))) {
      issues.push("replace the development administrator password in production");
    }
    if (config.sessionSecret.includes("laboratory-local")) {
      issues.push("replace the development session secret in production");
    }
  }
  if (issues.length) throw new Error(`Invalid Laboratory configuration: ${issues.join("; ")}`);
}
