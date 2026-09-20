# Settings compatibility and release qualification

Backup, Updates, Wyverne Connection and Logs keep Laboratory's visual theme while sharing the service-agent behavior: masked Initialize overlay, durable job observation, explicit binding confirmation, scoped helper updates, independent application-owned backup policy, and complete cursor-based log history.

The installed helper version and a reachable socket are not enough to prove compatibility. Release construction must verify the signed Updater bundle's Wyvern capability and `release-trust/wyvern.pem`, the signed Wyvern manifest, and the tested Kernel/Volt publication and scoped-resolution contracts. The historical Updater 0.5.0 pin is not a claim that its published bundle includes these later capabilities. Replace `.release/updater.version` and its archive SHA-256 together only after the new signed bundle is published and qualified. Do not invent a digest or replace an existing release asset.

Apply compatible Neptune and Saturn policy releases before this application release. Settings owns its own schedule; Saturn central Synchronization no longer edits it. Standard backups preserve backup-policy and Wyvern-binding intent, without gateway credentials. Restored intent stays pending verification until the scoped destination/binding has been checked.

`services.wyvern.management_url` is an optional public HTTPS destination resolved fresh through Kernel for the management action. Configure an actual authorized management UI; do not infer a web admin URL from the daemon socket. This value never contains credentials. An unavailable or missing destination is shown as a configuration error.

Production rollout requires a tested immutable producer tuple and Linux/systemd install/reuse/update/rollback. Browser fixtures and mocked providers do not establish live-provider readiness or release availability. No production configuration, Kernel Register value or Volt secret is changed by this source implementation.
