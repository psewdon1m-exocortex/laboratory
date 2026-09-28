# Settings compatibility and release qualification

Backup, Updates, Wyverne Connection and Logs keep Laboratory's visual theme. Wyvern installation, Adapter administration and shared release checks/updates use `sudo updater tui`; the Settings card only selects a permitted Adapter for Laboratory's functions. Its existing Initialize and version controls display TUI guidance without starting a host operation. Neptune keeps its scoped Initialize workflow, and Laboratory keeps its own update and backup flows.

The installed helper version and a reachable socket are not enough to prove compatibility. Release construction verifies the signed Updater 0.6.0 bundle's Wyvern capability and `release-trust/wyvern.pem`, the signed Wyvern 0.0.3 manifest, and the tested Kernel/Volt publication and scoped-resolution contracts. `.release/updater.version` and its archive SHA-256 identify the same published artifact; never invent a digest or replace an existing release asset.

Apply compatible Neptune and Saturn policy releases before this application release. Settings owns its own schedule; Saturn central Synchronization no longer edits it. Standard backups preserve backup-policy and Wyvern-binding intent, without gateway credentials. Restored intent stays pending verification until the scoped destination/binding has been checked.

`services.wyvern.management_url` is an optional public HTTPS destination resolved fresh through Kernel for the management action. Configure an actual authorized management UI; do not infer a web admin URL from the daemon socket. This value never contains credentials. An unavailable or missing destination is shown as a configuration error.

Production rollout requires a tested immutable producer tuple and Linux/systemd install/reuse/update/rollback. Browser fixtures and mocked providers do not establish live-provider readiness or release availability. No production configuration, Kernel Register value or Volt secret is changed by this source implementation.
