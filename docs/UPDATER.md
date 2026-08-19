# Updater compatibility

Laboratory was audited against `psewdon1m-exocortex/updater` tag `updater-v0.2.1` and commit `b302022bf2b45a1e14d0e35b9c1a64d0127d6f58`.

The application sends `request_id`, `head_id=laboratory`, `service=laboratory`, the requested semantic version and one base64-encoded SHA-256 backup to `POST /v1/updates` over the local Unix socket with `X-Updater-Token`. This matches the current updater model. The release is resolved independently from `repositories.laboratory.url` in verified Kernel Register, and `laboratory-release.json` supplies the immutable image digest and compose-bundle checksum.

Important constraints:

- the decoded backup must not exceed 128 MiB;
- release tags are `laboratory-vX.Y.Z` and assets are exactly `laboratory-release.json` and `laboratory-X.Y.Z-compose.tar.gz`;
- `UPDATER_COMPOSE_FILE=compose.production.yaml` must include the updater socket mount itself;
- `LABORATORY_IMAGE` and `LABORATORY_VERSION` are updater-managed and rewritten atomically;
- host restore uses `UPDATER_RESTORE_URL` and `UPDATER_RESTORE_FIELD=file`, authenticated by the same control token;
- compose-contract changes require bootstrap/redeploy because updater 0.2.x performs image replacement using the installed compose file.

Updater's own upstream Go suite passed during this audit. Laboratory CI validates the corresponding release manifest, backup ceiling, single-file compose contract and exact image smoke path.
