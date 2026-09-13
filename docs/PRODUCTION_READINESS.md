# Production readiness record

This record applies the workspace-wide
[Part 00 authority](https://github.com/psewdon1m-exocortex/general/blob/main/PART_00_SYSTEM_UNIFICATION_SPECIFICATION.md) to
Laboratory. The status rows below distinguish implemented evidence from the
required target contract.

| Guide | Applicability | Decision / evidence |
| --- | --- | --- |
| Interface unification | Partial | Interaction/accessibility rules apply. Laboratory's photographic visual language is an explicit product decision and is preserved instead of adopting the shared visual theme. |
| Observability and log export | Applicable | Structured pseudonymized audit JSONL, bounded rotation, admin query/export, request IDs and container log rotation are implemented. Bodies, tokens and secrets are never logged. |
| Backup and recovery | Applicable | v3 complete logical backup, manifest hashes/counts, resource preflight, checkpoint, staged/transactional restore and negative tests. |
| Bootstrap and deployment | Blocked | The target is an exact-version bootstrap with embedded derived public key, manifest verification before download and a separate mode-0600 environment. Current release CI does not yet sign/build that trust path; see [RELEASING](../RELEASING.md). |
| CI, releases and updates | Partial | PR/main CI, build-once digest promotion, SBOM/provenance and rollback exist. Plain `v*` verification and the private-key-signed qualified release path remain release blockers. |
| Security and exposure | Blocked | Loopback/server-Nginx and private-route controls apply, but runtime login still uses username/password and must migrate to Access Key-only authentication. |
| Shared agents | Not currently applicable | Parts 09–11 define no Laboratory Neptune profile. Existing Laboratory Neptune hooks are non-normative until the central profile is explicitly extended. |
| SEO and GEO | Applicable | SSR metadata/schema, registries, sitemaps, crawler policy, feeds, Evidence API, Markdown and MCP retained for About and Journal. |

## Baseline and accepted divergences

The pre-hardening baseline had 14 passing tests, a working local server and valid About/Journal SEO. Material gaps were: incomplete backup manifest and state coverage; live-file writes before database restore; no pre-restore checkpoint or archive bomb preflight; backup size larger than updater's hard limit; updater socket located only in a compose overlay not reused by updater; image built twice in release; no pull-request CI, bootstrap installer or structured audit export.

The operator's request to improve backup/update/CI/deployment and deliver a production-ready build selects adoption with backward compatibility. Backup readers retain v1/v2 support. The original site appearance remains the previously approved visual divergence. The installed-Compose limitation first recorded against Updater 0.2.x is historical compatibility evidence, not the current version requirement; the coordinated deployment profile requires Updater 0.4.3+ and `compose_contract=2` still requires bootstrap/redeploy for existing contract-1 installations.

## Acceptance evidence

- application tests: 18 passed, including archive attack fixtures, updater request contract and restore rollback;
- production Compose: parses with no unresolved placeholders under a populated operator environment;
- container: pinned base, successful build, healthy as non-root with read-only root filesystem;
- production page smoke: About canonical/Person, Google-Extended policy and private noindex passed;
- release bundle: checksum and manifest contract verified, installer executable;
- historical upstream updater 0.2.1 audit: complete Go suite passed; current
  0.4.3+ qualification remains mandatory before release;
- dependency audit: zero known production vulnerabilities at the recorded run.

Before public deployment, the operator must configure the real Kernel URL/token, content GitHub token/webhook secret, session/admin secrets, updater token/socket GID, public SNI in Kernel Register and the edge TLS route. These values cannot be supplied or validated from source control.
