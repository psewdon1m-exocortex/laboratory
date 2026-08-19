# Production deployment

Laboratory is deployed as one non-root container behind an existing HTTPS edge. It does not install or configure nginx. The service publishes only a loopback host port and expects its canonical public URL, repository coordinates and AI provider key from Kernel Register.

## First installation

Use a tagged release, never `main`:

```sh
curl -fsSL https://raw.githubusercontent.com/psewdon1m-exocortex/laboratory/main/scripts/bootstrap.sh \
  | sudo sh -s -- --version X.Y.Z
sudoedit /opt/exocortex/laboratory/.env
sudo /opt/exocortex/laboratory/install.sh
```

Bootstrap verifies the release bundle SHA-256, rejects unsafe archive paths and stages a mode `0600` environment file. The operator changes only the `OPERATOR INPUT` values and every `CHANGE_ME` placeholder. `install.sh` requires Docker Compose v2, an already installed Exocortex Updater 0.2.0 or newer, an immutable `LABORATORY_IMAGE=...@sha256:...` reference, and a live updater Unix socket. It validates Compose before mutation, registers the `laboratory` head, starts the service and waits for health.

The host edge must route the public SNI to `127.0.0.1:18380` and terminate TLS. Kernel Register must contain `repositories.laboratory.url`, `repositories.laboratory.content.url`, `repositories.laboratory.content.branch`, and either `services.laboratory.url` or the matching SNI/port fields.

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

Updater 0.2.x verifies the release compose bundle but deliberately reuses the installed Compose project when replacing an image. An image-only release therefore must remain compatible with the installed compose contract. A release that raises `compose_contract` requires rerunning bootstrap/install before installing the image update. The release manifest records this number explicitly.

## Rollback

Updater stores the checksummed logical backup before mutation, rewrites image and version together, checks local and optional public health, and restores both the previous image and the Laboratory backup on failure. Manual rollback is available through the private UI while the retained updater job still reports `rollback_available`.
