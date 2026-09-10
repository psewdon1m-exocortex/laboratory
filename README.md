# Laboratory

## Автоматические резервные копии

После обычной установки создайте в Saturn одноразовый Neptune setup code и выполните `sudo laboratory-install backup`. Один host-wide Neptune обслуживает Laboratory вместе с другими сервисами; расписание включается в Settings.

Laboratory is the English-only publication module of Exocortex. It keeps the
photographic, grain-driven visual language of `simple_site` while providing:

- `/` — photographic hero and the About Me / Journal choices;
- `/about` — an uploaded Markdown profile in the Laboratory visual language;
- `/journal` — searchable and reversible article index with a refracting rail;
- `/journal/:slug` — a full-screen PDF or Markdown reader;
- `/private` — private content, article, backup and update controls.

The Node service owns the UI, API and static media. No nginx container or nginx
configuration is part of this module. In production an external edge proxy may
forward to the loopback-only listener.

## Local development

Requirements: Node.js 24+.

```bash
cd services/api
npm ci
npm test
npm start
```

The default address is `http://127.0.0.1:18380`. Local credentials are read from
the ignored root `.env`; production credentials must be injected separately.

Docker development is also available:

```bash
docker compose up --build
```

## Article publication

Runtime state lives under `data/runtime` locally and in the `laboratory-data`
volume in Docker. SQLite stores article identities, immutable revisions and
file metadata. Article bytes are stored alongside it with hashes recorded in
the database. The admin backup is a manifest-driven ZIP containing settings,
assets, article revisions, media, derivatives, tombstones and durable jobs.
See `docs/BACKUP_AND_RECOVERY.md` for exclusions and restore guarantees.

GitHub is the canonical publication inbox. The content repository URL and
branch are resolved from Kernel Register rather than compiled into Laboratory.
The primary format is one directly pushed Markdown or PDF file:

```text
published/
  The Shape of a Working Idea.md
  Standalone Report.pdf
unpublished/
  Unfinished Observation.md
```

The directory selects the state and the filename without `.md`/`.pdf` becomes
the title. A Markdown source must put exactly one ordinary Saturn folder share
URL on its first line. That line is consumed as import metadata and is never
rendered or exposed by Laboratory. Paths in the shared folder may already use
`media/` and `attachments/`; otherwise recognized image/audio/video/Open Node
files are placed under `media/` and other files under `attachments/`. The
folder name (for example `25.05.2026`) is organizational only; publication time
is assigned by Laboratory on the first successful import. Every normalized
revision receives a schema-tagged `metadata.json` automatically. A directly
pushed PDF is a standalone article and therefore has no first-line share
reference.

```markdown
https://drive.example.com/s/<share-token>

# Article body

::image{media/scheme.png}
```

The share must belong to the Saturn origin resolved from
`services.saturn.sni` and `services.saturn.port` in Kernel Register. It must be
an active, unlocked folder share in `browse` or `download_folder` mode.
Laboratory binds one Saturn share session and creates a hybrid immutable
revision. Files up to and including `LABORATORY_LOCAL_ASSET_MAX_BYTES`
(10 MiB by default) are downloaded once, verified by size, detected MIME and
SHA-256, and stored inside Laboratory. Larger files are not copied into
Laboratory: its scoped Saturn client asks the Gateway to pin the exact current
file version and stores only the stable `/a/{asset_id}/{filename}` URL, version
ID, size, MIME and digest. The browser then requests those large bytes directly
from Saturn with Range support and a one-year immutable cache policy. Saturn
does not create a new file or user-visible folder for this operation; the asset
record references the existing file version. The share capability itself is
never persisted in article metadata or rendered output.

Large remote files require `LABORATORY_SATURN_CLIENT_TOKEN`, issued once from
Saturn's scoped Laboratory client API, and Saturn public Laboratory delivery
must be enabled. A file above the threshold is rejected if Saturn does not
provide its SHA-256; it is never silently downloaded as a fallback. Open Node
projects remain local because their structure must be parsed during import.
A standalone GitHub PDF may be pushed directly only up to the local threshold;
for a larger PDF, put it in the Saturn folder and link it from a Markdown
article with `::file{attachments/report.pdf}`. Redirects to another origin are
rejected.

The full Laboratory backup contains local bytes plus the pinned Saturn asset
and version references. A standalone article ZIP is intentionally unavailable
for hybrid articles because it cannot preserve those remote pins; revise such
articles through their canonical GitHub Markdown source.

The previous ZIP inbox remains supported for compatibility. A ZIP archive
contains exactly one root-level `article.md` or `article.pdf`; optional files go
under `media/` or `attachments/`. Its filename remains the title and `_id.txt`
is optional on first import. Laboratory assigns an immutable ID such as
`l-01K2Q7W8N6M4` and may commit the normalized ZIP back to the same path.

```text
The Shape of a Working Idea.zip
  article.md
  _id.txt
  metadata.json
  media/
    scheme.png
    recording.mp3
    demonstration.mp4
    research-process.onode
  attachments/
    source-data.xlsx
```

`metadata.json` is optional and deliberately small. Author and language are
site-level defaults; reviewers, material types and fixed content blocks are not
part of the archive contract. Sources are optional:

```json
{
  "schema": "article.metadata.v1",
  "description": "An optional human-written search description.",
  "sources": [
    { "title": "Primary source", "url": "https://example.com/source" }
  ]
}
```

Markdown supports regular CommonMark/GFM plus validated block directives:

```markdown
::image{media/scheme.png}
::gallery{media/one.webp,media/two.webp}
::audio{media/recording.mp3}
::video{src="media/demonstration.mp4" poster="media/poster.webp" caption="Demonstration"}
::file{attachments/source-data.xlsx}
::workflow{media/research-process.onode}
```

A unique basename can be used without the directory prefix. Images occupy the
article width, audio and video receive native controls, file directives become
download rows, and unreferenced files under `attachments/` are appended to the
article automatically. Missing files, unsafe paths, invalid media and malformed
Open Node projects reject the new revision without replacing the published one.
ZIP files are limited to 95 MB and 256 entries, with separate expanded-size and
compression-ratio checks.

For an end-to-end local check, import `Laboratory Test Article.zip` from the
project root. It exercises every directive and intentionally omits `_id.txt`.
Regenerate it with `node scripts/create-test-article.mjs` from the Laboratory
directory.

The Open Node viewer uses the vendored `0.1.0` visual-only, read-only embed. It
is loaded about 650 px before the canvas reaches the viewport. The wheel always
scrolls the article; Ctrl/Command plus wheel zooms the workflow under the
cursor. Hold Space and drag, or use the middle mouse button, to pan. Unknown
custom node types receive decorative placeholder definitions so a visual-only
canvas does not report missing runtime plugins. Execution, editing, saving and
plugin loading are not exposed.
The browser bundle is committed under `services/web/static/vendor`; after an
Open Node upgrade, install its workspace dependencies and run
`node scripts/build-open-node-viewer.mjs` from the Laboratory root.
The build records the exact Kernel commit and SHA-256 values in
`open-node-viewer.manifest.json`; CI verifies that manifest without requiring a
mutable sibling checkout.

## Search, GEO and derived content

Public pages are rendered with meaningful HTML, canonical metadata and JSON-LD
on the server. The existing browser scripts progressively enhance that HTML and
retain the same interactive interface. Discovery and machine-readable resources
are generated from the published SQLite revisions, so no file needs to be
updated when an article is added:

- `/sitemap-index.xml` with deterministic page and article shards;
- `/robots.txt` with separate search and model-training policy;
- `/llms.txt` plus per-page Markdown representations at `/index.md`,
  `/about.md`, `/journal.md` and `/journal/:slug.md`;
- `/feed.xml`;
- `/api/public/v2/openapi.json`, cursor-paginated publication metadata and the
  indexed Evidence API;
- `/mcp`, a stateless public MCP Streamable HTTP endpoint;
- the compatible `/api/public/v1/*` endpoints for existing consumers.

Publication, revision, canonical, visibility, deletion, derived-content and
site-profile changes append a monotonic `public_content_events` record in the
same database transaction. HTML and discovery routes use that journal for
freshness validators and require intermediary revalidation. Uploaded Markdown
headings are nested beneath the single server-rendered page H1. For PDF
articles, the validated transcript is available to ordinary users in the
collapsed `Text version` section as well as through the retrieval APIs.

The Evidence API is intentionally read-only. Public evidence is materialized in
SQLite and searched through FTS5 rather than by rescanning every article. It
exposes canonical source URLs, stable revision-aware locators, normalized text
digests and source hashes; it does not promise or force a model to cite the
site. Publication text is explicitly marked as untrusted data rather than agent
instructions. Public API and MCP requests have independent per-IP fixed-window
limits controlled by `LABORATORY_PUBLIC_API_RATE_LIMIT` (default 120/minute) and
`LABORATORY_MCP_RATE_LIMIT` (default 60/minute).

MCP exposes three read-only, idempotent tools:

- `list_publications` lists published work with cursor pagination;
- `search_publications` searches verified passages and groups them by article;
- `get_publication` returns one article by stable ID or slug with requested
  abstract, evidence, assets and/or Markdown content.

It also exposes `laboratory://catalog` and the
`laboratory://articles/{reference}` resource template. There are no mutation,
administration or publication tools on the public MCP endpoint.

`robots.txt` permits public search agents and explicitly permits
`Google-Extended`, while private/admin paths remain disallowed. GPTBot,
ClaudeBot and Applebot-Extended keep their separate training-crawler policy.
A state-changing Agent Action API should only be added when the product has a
real delegated action to perform.

Gemini-derived artifacts are disabled until configured. Once enabled, a durable
SQLite worker automatically processes every new published revision, validates a
structured response and writes `abstract.md`, `transcript.md` (PDF only),
`evidence.json` and `generation-manifest.json` beside the immutable source
revision. The source ZIP is never mutated. Configure:

```text
LABORATORY_AI_PIPELINE_ENABLED=1
LABORATORY_GEMINI_MODEL=gemini-2.5-flash
LABORATORY_GEMINI_MAX_OUTPUT_TOKENS=8192
LABORATORY_GEMINI_THINKING_BUDGET=0
```

The default thinking budget is zero because this pipeline performs faithful
transcription and bounded extraction rather than open-ended reasoning. This
reserves the output-token allowance for the article artifacts themselves.
Set `LABORATORY_AI_PIPELINE_ENABLED=0` to pause all model work while keeping
published derivatives available. Set it to `1` to enable the worker.

The Gemini API key is represented by
`services.laboratory.ai.gemini_api_key` in Kernel Register as a
`volt://<entry-id>/<field-id>` reference. Laboratory asks Kernel to
resolve the Register key and keeps the returned value only in process memory.
Laboratory has no Volt URL or token; Register caches and Laboratory backups
never contain the resolved value.

The system instruction is versioned at
`services/api/src/prompts/article-derivatives.system.txt`. Failed jobs do not
block or roll back publication. Administrators can queue a clean regeneration
through `POST /api/admin/articles/:id/derivatives/regenerate`.

IndexNow is available for new published revisions when
`LABORATORY_INDEXNOW_ENABLED=true` and `LABORATORY_INDEXNOW_KEY` is configured.
The key proof file is served automatically.

The Google Indexing API path is an isolated research feature. Google officially
supports that API only for `JobPosting` and livestream `BroadcastEvent` pages,
so ordinary articles must not depend on it. It is disabled by default and
requires an experiment end date, a daily cap, a deterministic treatment/control
split and Application Default Credentials:

```text
LABORATORY_GOOGLE_INDEXING_EXPERIMENT_ENABLED=true
LABORATORY_GOOGLE_INDEXING_EXPERIMENT_END_DATE=2026-09-30
LABORATORY_GOOGLE_INDEXING_EXPERIMENT_MAX_URLS_PER_DAY=1
LABORATORY_GOOGLE_INDEXING_EXPERIMENT_SAMPLE_PERCENT=50
GOOGLE_APPLICATION_CREDENTIALS=/run/secrets/google-indexing-service-account.json
```

The production compose file also accepts
`LABORATORY_GOOGLE_SERVICE_ACCOUNT_BASE64`, containing the service-account JSON
encoded as base64, when an external secret mount is not available. Keep either
credential form outside version control.

An accepted API notification is recorded as `accepted`, never as `indexed`.
The admin state API reports generation and search-notification queue health.

`published/` archives are visible on the public Journal; `unpublished/` archives
are visible only in `/private`. A new import is published by default.

To delete through the Git-first workflow, remove the archive and push the commit:

```bash
git rm "published/The Shape of a Working Idea.zip"
git commit -m "laboratory: delete article"
git push origin main
```

The webhook unpublishes a removed source and retains its immutable local
revisions and stable ID. Re-adding the same source path publishes a new revision.
Permanent deletion remains an explicit administrator action.

`/private` can import/export the same ZIP, edit Markdown and metadata, replace
the main PDF/Markdown file, add or remove media and attachments, switch between
published and unpublished, inspect IDs and revision history, collapse the open
editor, delete an article, and request a full GitHub sync. With a configured
GitHub token, administrator deletion removes the repository archive first. If
writeback is unavailable, the admin reports that the deletion was local only.

## Kernel Registry, GitHub and Updater

Laboratory reads these Register keys as `volt://` references, retains only the
verified reference snapshot, and batch-resolves the required values through
Kernel. There are no environment-variable fallbacks for the article repository
URL or branch, and a fresh process requires available Kernel and Volt:

- `repositories.laboratory.url`
- `repositories.laboratory.content.url`
- `repositories.laboratory.content.branch`
- `services.laboratory.url`, or `services.laboratory.sni` plus `.port`
- `services.saturn.sni`
- `services.saturn.port`
- `services.laboratory.ai.gemini_api_key`
- `intervals.kernel.refresh_sec`

The content repository webhook endpoint is `/api/github/webhook`. Configure a
GitHub push webhook with JSON payloads and the same secret as
`LABORATORY_CONTENT_WEBHOOK_SECRET`. The token in
`LABORATORY_CONTENT_GITHUB_TOKEN` needs repository Contents read/write access
for admin writeback and automatic `_id.txt` commits. Actual values never belong
in Kernel Register; only their Volt references do.

Push deliveries are validated against both the registered repository and
`refs/heads/<registered-branch>` before acceptance, deduplicated by
`X-GitHub-Delivery`, and stored in a durable SQLite queue. The worker reconciles
the complete source tree at the exact pushed commit SHA; a process restart
returns interrupted work to `pending` instead of losing the accepted webhook.

The production release bundles the pinned, checksum-verified Updater installer.
Bootstrap generates `LABORATORY_SESSION_SECRET`, `UPDATER_CONTROL_TOKEN`, socket
group IDs and Neptune client tokens without rotating existing values. A local
Kernel URL and service token are copied automatically from
`/opt/exocortex/kernel/.env`; only a remote Kernel requires those two values to
be entered manually. The installer then installs or safely upgrades Updater and
registers the head as `laboratory`. Before replacement the module creates its
own v3 backup; Updater can restore it through the token-protected internal
restore endpoint.
Published releases use `laboratory-vX.Y.Z` tags and a
`laboratory-release.json` manifest.

## Production

Bootstrap a specific release, edit only the remaining OPERATOR INPUT values in
the mode-0600 file, then run the installer. Do not replace generated Updater or
Neptune tokens manually:

```bash
curl -fsSL https://raw.githubusercontent.com/psewdon1m-exocortex/laboratory/main/scripts/bootstrap.sh \
  | sudo sh -s -- --version X.Y.Z
sudoedit /opt/exocortex/laboratory/.env
sudo laboratory-install
```

The application remains bound to `127.0.0.1` by design. TLS termination and
public routing belong to the host edge layer, not this module.
The production runbook, backup drill, updater compatibility and CI contract are
under `docs/`.
