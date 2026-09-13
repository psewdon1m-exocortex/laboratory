# Production deployment

This document specializes [Part 04 — bootstrap and deployment](../../.docs/PART_04_BOOTSTRAP_AND_DEPLOYMENT.md); that central contract remains authoritative.

Laboratory is deployed as one non-root container behind the single server-managed Nginx. It does not ship or run an embedded Nginx. The service publishes only a loopback host port and expects its canonical public URL, repository coordinates and AI provider key from Kernel Register.

## First installation

> Target contract: the exact-version signed-bootstrap steps below become an
> approved production path only after the release blocker in
> [RELEASING.md](../RELEASING.md) is closed and verified.

Use a tagged release, never `main`:

```sh
curl -fsSL https://github.com/psewdon1m-exocortex/laboratory/releases/download/laboratory-vX.Y.Z/bootstrap.sh \
  | sudo sh
sudoedit /opt/exocortex/laboratory/.env
sudo chmod 600 /opt/exocortex/laboratory/.env
sudo laboratory-install
sudo laboratory-install status
curl -fsS http://127.0.0.1:18380/api/health
```

Release CI keeps Laboratory's private signing key only in GitHub Secrets and embeds only the derived public counterpart in this versioned bootstrap. Bootstrap creates `/etc/exocortex/release-trust/laboratory.pem`, verifies the signed manifest before trusting its artifact URL or digest, verifies the bundle SHA-256, rejects unsafe archive paths and stages Laboratory's separate mode-`0600` environment file. It fails on an existing mismatching trust key and uses no `scp`, manual release-key fingerprint or separately downloaded public key. The operator changes only the `OPERATOR INPUT` values and every `CHANGE_ME` placeholder. `install.sh` requires Docker Compose v2, Exocortex Updater 0.4.3 or newer, an immutable `LABORATORY_IMAGE=...@sha256:...` reference, and a live updater Unix socket. It validates Compose before mutation, registers the `laboratory` head, starts the service and waits for health.

Server-managed Nginx must route the public SNI to `127.0.0.1:18380` and terminate TLS. The `/private` login is reachable from every client IP; there is no `OPERATOR_CIDR`, VPN prerequisite or source-IP allow-list. Access Key validation and the bounded application session protect all private routes. Kernel Register must contain `repositories.laboratory.url`, `repositories.laboratory.content.url`, `repositories.laboratory.content.branch`, and either `services.laboratory.url` or the matching SNI/port fields.

## Runtime hardening

The production Compose contract uses a read-only root filesystem, a bounded no-exec `/tmp`, non-root `node`, dropped capabilities, `no-new-privileges`, PID/CPU/memory limits, loopback-only publication and rotated Docker logs. Persistent data is confined to the `laboratory-data` volume. The updater socket directory is mounted read-only and access is granted through its numeric GID.

Run after installation:

```sh
docker compose --env-file /opt/exocortex/laboratory/.env \
  -f /opt/exocortex/laboratory/compose.production.yaml config --quiet
curl -fsS http://127.0.0.1:18380/api/health
sudo updater status
```

Do not copy local `.env`, `.secrets`, `data/runtime`, Kernel cache files or test credentials to production.

## Compose contract changes

The current Updater 0.4.3+ contract verifies the release Compose bundle but deliberately reuses the installed Compose project when replacing an image. An image-only release therefore must remain compatible with the installed compose contract. A release that raises `compose_contract` requires rerunning bootstrap/install before installing the image update. The release manifest records this number explicitly.

## Rollback

Updater stores the checksummed logical backup before mutation, rewrites image and version together, checks local and optional public health, and restores both the previous image and the Laboratory backup on failure. Manual rollback is available through the private UI while the retained updater job still reports `rollback_available`.
