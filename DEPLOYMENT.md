# Deploying laboratory

This document retains the historical laboratory-v0.1.3 deployment sequence below. The current Wyvern integration source is a new unpublished candidate: do not deploy it using that old tag. First qualify Kernel 0.3.0 / Volt 0.2.0 publication support, publish Updater 0.6.0 with Wyvern trust, then Wyvern 0.0.1. Update `.release/updater.version` and `.release/updater.sha256` together from the real signed Updater artifact before building the new Laboratory release. Its existing 0.5.0 pin cannot satisfy the Wyvern capability gate. Source changes are not published releases.

The new installer ensures/reuses Wyvern before starting the consumer. Configure its Adapter in `sudo updater tui`, grant Laboratory access, and select `derivatives` in Settings → Wyvern. Application installation can succeed while LLM configuration is still incomplete. Start production only after the exact immutable tag, anonymous assets, signature, Part 12 report and live-provider check pass. See [Wyvern operations](https://github.com/psewdon1m-exocortex/wyvern/blob/main/docs/operations.md).

## Ownership and release order

Kernel, Volt and Saturn are already deployed and are not replaced by this installer. Publish compatible Updater 0.4.6 first; the head bundle pins it. Updater upgrades an older host agent and adds this head to its existing registry. Existing newer agents are reused. Publish Neptune Linux 0.1.6 before connecting the new heads: it bounds shared Kernel requests and preserves older state. Gryphon Linux 0.1.2 is compatible and needs no new release. Migration fixtures cover Updater 0.4.3/0.4.4/0.4.5, Neptune Linux 0.1.0/0.1.1 and unified 0.1.5 and Gryphon Linux 0.1.0/0.1.1; first read actual server versions before upgrading.

The operator explicitly authorized this head profile on 2026-09-14. Its additive typed profile lives in services/api/src/deployment-profile.json. Kernel's initial six-service profile remains unchanged. Add bindings manually without replacing or pruning existing entries; the head validates its own required keys, including content branch as a branch rather than a URL.

## Operator sequence on the intended Linux server

Record hostname, working directory and installed agent versions before changes. Prepare Docker Compose v2, curl, OpenSSL, Python 3 and server nginx yourself. DNS egress, github.com/release-assets.githubusercontent.com, ghcr.io and the Kernel/Saturn HTTPS origins must be reachable. No incoming application port is public.

```bash
curl -fsSL https://github.com/psewdon1m-exocortex/laboratory/releases/download/laboratory-v0.1.3/bootstrap.sh | sudo sh
sudoedit /opt/exocortex/laboratory/.env
sudo chmod 600 /opt/exocortex/laboratory/.env
sudo laboratory-install
sudo laboratory-install status
curl -fsS http://127.0.0.1:18380/api/health
```

Fill only LABORATORY_ACCESS_KEY, KERNEL_URL (canonical HTTPS origin), and KERNEL_SERVICE_TOKEN (the scoped machine credential issued for this head). Bootstrap supplies the immutable image digest, local session secret and helper control/export credentials. Do not copy another service's .env or release private key. The installer generates the actual Docker gateway proxy addresses; there is no operator IP allowlist or wildcard proxy trust.

LABORATORY_ACCESS_KEY must be explicitly present but has no length,
composition, character-set, URL-safe/ASCII, strength/entropy or value-denylist
policy. Every supported path must preserve the exact operator-supplied value.
The current 12–1024-character validation is a documented `BST-13`
implementation gap, not a deployment requirement.

Bootstrap has no arguments. It rejects a mismatched signature, version, digest, unsafe tar member, foreign existing trust key or existing installation. After an interrupted staging, inspect the fixed target before removing only a newly created incomplete directory; an established deployment must be updated through its authenticated Updater. Re-running prepare/install preserves operator values. An update merges missing safe defaults; rollback restores the exact previous .env and deployment plus the supplied data backup.

## Volt values and Kernel bindings

Create a separate Volt entry/field for every value below and bind the Register key to volt://ENTRY_UUID/1 (or the appropriate numeric field 1–5). Never put a plaintext credential into Register. Existing common bindings services.saturn.sni/port and repositories.updater/neptune.url remain authoritative. Do not edit the six-service seed/profile to add this head.

| Register key | Value / responsibility |
| --- | --- |
| repositories.laboratory.url | https://github.com/psewdon1m-exocortex/laboratory |
| services.laboratory.sni | Your canonical hostname, without scheme or path |
| services.laboratory.port | Public HTTPS port, normally 443 |
| services.laboratory.health.path | /api/health |
| services.laboratory.health.contract | public-readiness |
| services.laboratory.backup.saturn_slug | Exact producer slug returned by Saturn enrollment |
| repositories.laboratory.content.url | Canonical GitHub content repository HTTPS URL |
| repositories.laboratory.content.branch | Branch name, e.g. main |
| services.laboratory.credentials.github_token | Scoped content repository credential |
| services.laboratory.credentials.github_webhook_secret | Independent GitHub webhook HMAC secret |
| services.laboratory.credentials.saturn_client_token | Saturn Laboratory-client credential for immutable remote assets |
| services.laboratory.credentials.google_service_account_base64 | Only when the Google indexing experiment is explicitly enabled; base64 service-account JSON |

IndexNow's verification key is intentionally public and is not an access credential. In Laboratory it is an optional environment setting. GitHub, Saturn and Google indexing private credentials are resolved through Kernel, remain in memory and are excluded from backups/log exports. LLM credentials belong to the selected Wyvern Adapter; Laboratory uses only its own client link and `derivatives` binding. The Kernel URL and initial machine token are the bootstrap exception; subsequent Laboratory connection edits are encrypted locally and excluded from portable recovery.

### IndexNow production activation

Application support is installed but disabled by default. Generate the ownership
key from a trusted checkout:

```bash
cd services/api
npm run indexnow:key
```

Store the printed value in the production environment as
`LABORATORY_INDEXNOW_KEY`, set `LABORATORY_INDEXNOW_ENABLED=true`, and deploy.
The canonical public URL continues to come from Kernel Register. Before running
the queue, fetch `https://<canonical-host>/<key>.txt` externally and confirm the
body is exactly the key. Then authenticate to the private API, inspect
`GET /api/admin/search-notifications`, and invoke
`POST /api/admin/search-notifications/run` with the normal CSRF token. A ready
preflight plus `accepted` jobs proves provider receipt only; indexing must be
verified separately in the search-engine consoles. Recent errors are exposed
without the ownership key or private credentials.

## Agents and public activation

In the head's Settings, initialize Neptune with a one-time archive setup code issued in Saturn. One host daemon can serve the existing projects and both new heads. Saturn → Synchronization owns desired schedules, manual remote runs and run receipts. A saved schedule or installed binary is not proof of a successful backup: inspect enrolled/linked state, last seen, last successful backup, next due and overdue status separately. Revoke old credentials in their issuer and reconnect using a newly issued code; do not reuse an already consumed code.

Laboratory does not consume Gryphon. Test a signed GitHub webhook on the registered branch, import a Markdown/PDF source, and confirm unpublished/published transitions and immutable Saturn assets. If AI is enabled, verify a real Gemini generation before declaring it operational.

Use nginx.server.example.conf as the service-specific server configuration template. It is an example for the operator-managed nginx, not a proxy installed by this service. Configure an independent default server rejecting unknown Host/SNI, exact server_name and certificate pair, then run nginx -t. The template binds only the intended upstream, forwards Host/proto/client identity, denies machine-only routes, and sets route-specific upload limits/timeouts with bounded server staging. No coturn is installed. Login remains reachable from every client IP; public articles/About/Journal are indexable and private/admin surfaces are noindex.

Run public checks from two independent external clients after nginx configuration: DNS/TLS/SNI; correct canonical links; unauthenticated private API refusal; unpublished file refusal; CSRF and logout replay rejection; no direct 18380/database port; oversized upload 413. Unknown/stale telemetry is not zero. /api/health reports core database/Register readiness; authenticated /api/ready reports the required agents/dependencies. It explicitly does not claim external provider delivery.

## Recovery and acceptance

Export → Neptune → Saturn receipt → actual stored SHA-256 → download → isolated clean restore is the required drill. Local settings, content/history, authoritative metadata and Access Key verifier are included; plaintext secrets are not. Restore retains the target enrollment credentials and invalidates all previous sessions. Log in again with the restored Access Key. Large remote assets require Saturn to be recovered first. The current Saturn origin is resolved from Kernel, while immutable IDs/digests remain stable. SQLite and the local media tree use a persistent restore journal; startup completes or rolls back an interrupted switch. ZIP compression/validation runs away from the main request loop, with a 128 MiB compressed / 512 MiB expanded archive limit; keep head memory limits and server upload quota consistent.

A backup on the same physical failure domain is not independent disaster recovery. Confirm a separate Saturn storage/account and a tested off-host recovery copy using the operator's infrastructure policy. Do not label that production check PASS from a local fixture.

After a change record UTC time, hostname, service version/image digest, container state, redacted logs, command/endpoint, migration result, core readiness, authenticated integrations and backup receipt/rollback metadata. Exclude .env, bearer values, private keys and request bodies. Only close an incident after its regression and updated runbook pass. The release gate stores production activation as NOT_RUN until the external checks above are performed.
A single instance admits one archive/upload operation at a time; concurrent requests receive 409 with Retry-After. Disconnecting a client does not release a running worker. Local files are size-checked before allocation. The default memory budget is 2 GiB for bounded 128 MiB compressed / 512 MiB expanded recovery plus the pre-restore safety copy. Reserve this capacity before install; increasing archive limits requires a separate load qualification.
