# Backup and recovery

This document specializes [Part 03 — backup and recovery](https://github.com/psewdon1m-exocortex/general/blob/main/PART_03_BACKUP_AND_RECOVERY.md); that central contract remains authoritative.

New backups use `exocortex.laboratory.backup.v3` inside `exocortex.laboratory.backup-manifest.v2`. Restore remains compatible with v1 and v2 archives.

## Included state

- site settings and uploaded About/Hero/Journal assets;
- the monotonic public-content lifecycle/freshness journal;
- stable article identities, slugs and aliases;
- every article revision, source file, media and attachment;
- deleted/unpublished URL tombstones and Git synchronization state;
- generated abstracts, transcripts, evidence manifests and immutable generation artifacts;
- durable AI generation jobs and search-notification jobs/state.

The manifest inventories every member with its uncompressed size and SHA-256. The logical data member also records row counts per authoritative collection.

The Access Key verifier and session generation are included as recovery metadata. Restore revokes existing sessions and retains the target machine enrollment. Plaintext secrets, session cookies, `.env`, Kernel Register cache, the rebuildable FTS evidence index, raw public telemetry, transient restore staging, pre-restore checkpoints and audit logs are intentionally excluded. Telemetry is deliberately local and retention-bounded; audit records have a separate manifest/checksum ZIP export in `/private` and must be shipped or archived by the operator if longer retention is required.

## Safety limits and validation

The complete ZIP is limited to 128 MiB by the retained Updater transfer
contract used by the current 0.4.6+ deployment profile. Preflight parses the
ZIP central directory before decompression and rejects ZIP64/multi-disk
archives, encryption, unsupported compression, more than 10,000 members,
members over 128 MiB, expanded archives over 512 MiB, excessive compression
ratios, duplicates, traversal, absolute paths and non-UTF-8 names. Manifest
membership, byte sizes and hashes are verified before any mutation.

## Restore transaction

Every restore first writes a mode `0600` pre-restore checkpoint under `data/restore-points` (three retained). Files are built in a new staging tree. Laboratory then opens an immediate SQLite transaction, atomically swaps the upload tree, replaces database state, runs foreign-key checks and commits. Any failure rolls back SQLite and restores the previous file tree. Requests receive `503 Retry-After` while the write barrier is active; in-flight workers discard stale results by restore epoch.

## Drill procedure

1. Download a backup from `/private`.
2. Restore it into a clean temporary deployment and compare article IDs, revisions, assets, derivatives, public-content events and counts.
3. Restore over deliberately changed state and confirm old orphans disappear.
4. Verify corrupt member, traversal and compression-bomb fixtures are rejected before mutation.
5. Force an insertion failure and verify both database and files retain the pre-restore state.
6. Confirm `/api/health`, About, Journal, article media and updater rollback restore.

The automated suite covers steps 2–5 at the storage boundary. A production restore drill should be performed at least once per release train and after schema changes.

A persistent restore journal and SQLite commit marker reconcile interrupted file switches at startup. Large ZIP compression and validation run outside the main request loop. See [the deployment runbook](../DEPLOYMENT.md) for remote Saturn assets and post-restore acceptance.
