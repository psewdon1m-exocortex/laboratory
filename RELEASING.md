# Releasing Laboratory

1. Update the application version and review migrations/backups.
2. Merge a pull request with a green `Laboratory CI / verify` check.
3. Confirm backup/restore and compose-contract compatibility.
4. Push an annotated `laboratory-vX.Y.Z` tag whose version matches `services/api/package.json`.

The release workflow publishes immutable GHCR image tags and attaches:

- `laboratory-X.Y.Z-compose.tar.gz`;
- `laboratory-X.Y.Z-compose.tar.gz.sha256`;
- `bootstrap.sh`;
- `laboratory-release.json`.

Updater resolves only GitHub releases whose tag and manifest identity match.
The manifest pins the image digest and the compose-bundle SHA-256 checksum.
Rollback is supported because Laboratory uploads a complete SQLite/media backup
before asking Updater to replace the container.
The workflow builds once, smoke-tests the published candidate digest and promotes
that exact digest with SBOM/provenance. See `docs/CI_AND_RELEASES.md`.
