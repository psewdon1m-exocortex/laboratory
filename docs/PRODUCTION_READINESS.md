# Production readiness record

This record applies the project-wide `.docs` guides to Laboratory.

| Guide | Applicability | Decision / evidence |
| --- | --- | --- |
| Interface unification | Partial | Interaction/accessibility rules apply. Laboratory's photographic visual language is an explicit product decision and is preserved instead of adopting the shared visual theme. |
| Observability and log export | Applicable | Structured pseudonymized audit JSONL, bounded rotation, admin query/export, request IDs and container log rotation are implemented. Bodies, tokens and secrets are never logged. |
| Backup and recovery | Applicable | v3 complete logical backup, manifest hashes/counts, resource preflight, checkpoint, staged/transactional restore and negative tests. |
| Bootstrap and deployment | Applicable | HTTPS bootstrap, mode-0600 operator file, immutable digest, compose validation, non-root/read-only runtime and health gate. |
| CI, releases and updates | Applicable | PR CI separated from tag release, build-once/promote digest, SBOM/provenance, checksummed updater manifest and rollback contract. |
| SEO and GEO | Applicable | SSR metadata/schema, registries, sitemaps, crawler policy, feeds, Evidence API, Markdown and MCP retained for About and Journal. |

## Baseline and accepted divergences

The pre-hardening baseline had 14 passing tests, a working local server and valid About/Journal SEO. Material gaps were: incomplete backup manifest and state coverage; live-file writes before database restore; no pre-restore checkpoint or archive bomb preflight; backup size larger than updater's hard limit; updater socket located only in a compose overlay not reused by updater; image built twice in release; no pull-request CI, bootstrap installer or structured audit export.

The operator's request to improve backup/update/CI/deployment and deliver a production-ready build selects adoption with backward compatibility. Backup readers retain v1/v2 support. The original site appearance remains the previously approved visual divergence. Updater 0.2.x's installed-compose limitation is documented rather than hidden; `compose_contract=2` requires bootstrap/redeploy for existing contract-1 installations.

## Acceptance evidence

- application tests: 18 passed, including archive attack fixtures, updater request contract and restore rollback;
- production Compose: parses with no unresolved placeholders under a populated operator environment;
- container: pinned base, successful build, healthy as non-root with read-only root filesystem;
- production page smoke: About canonical/Person, Google-Extended policy and private noindex passed;
- release bundle: checksum and manifest contract verified, installer executable;
- upstream updater 0.2.1: complete Go suite passed;
- dependency audit: zero known production vulnerabilities at the recorded run.

Before public deployment, the operator must configure the real Kernel URL/token, content GitHub token/webhook secret, session/admin secrets, updater token/socket GID, public SNI in Kernel Register and the edge TLS route. These values cannot be supplied or validated from source control.
