# Releasing Laboratory

This document specializes [Part 05 — CI/CD and release
security](../.docs/PART_05_CI_RELEASES_AND_LOCAL_UPDATES.md) for this service. If
the two documents differ, Part 05 is authoritative.

Laboratory follows SemVer from the initial `0.0.1`. A plain tag such as
`v0.0.1` invokes verification-only CI and must not publish or mutate a release;
only `laboratory-vMAJOR.MINOR.PATCH` may invoke the release workflow.

> Current implementation gap (2026-09-13): `ci.yml` does not yet listen to
> plain `v*` tags. The release workflow also does not yet sign the manifest or
> build an exact-version bootstrap with the embedded public key described
> below. Runtime authentication also still uses username/password instead of
> the required Access Key-only model, and current Neptune integration has no
> approved Laboratory profile in Parts 09–11. These material Part 04/05/07/09
> divergences block the next release until a separate CI/code change is
> implemented and verified.

1. Update the application version and review migrations/backups.
2. Merge a pull request with a green `Laboratory CI / verify` check.
3. Confirm backup/restore and compose-contract compatibility.
4. Push an annotated `laboratory-vX.Y.Z` tag whose version matches `services/api/package.json`.

The release workflow publishes immutable GHCR image tags and attaches:

- `laboratory-X.Y.Z-compose.tar.gz`;
- `laboratory-X.Y.Z-compose.tar.gz.sha256`;
- `bootstrap.sh`;
- `laboratory-release.json`.

The protected signing job reads Laboratory's private release key only from
GitHub Secrets, signs `laboratory-release.json`, derives the public counterpart
and embeds only that public key in the versioned `bootstrap.sh`. CI must verify
the signature, checksums, bootstrap trust payload and absence of private-key
bytes before publication. Bootstrap creates
`/etc/exocortex/release-trust/laboratory.pem` and Laboratory's separate
mode-`0600` `.env`, then verifies the manifest before downloading the service.
Do not use `scp`, a manual release-key fingerprint or a public key downloaded
beside the manifest as the initial trust path.

Updater resolves only GitHub releases whose tag and manifest identity match.
The manifest pins the image digest and the compose-bundle SHA-256 checksum.
Rollback is supported because Laboratory uploads a complete SQLite/media backup
before asking Updater to replace the container.
The workflow builds once, smoke-tests the published candidate digest and promotes
that exact digest with SBOM/provenance. See `docs/CI_AND_RELEASES.md`.
