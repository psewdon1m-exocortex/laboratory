# CI and releases

This document specializes [Part 05 — CI, releases and local updates](https://github.com/psewdon1m-exocortex/general/blob/main/PART_05_CI_RELEASES_AND_LOCAL_UPDATES.md); that central contract remains authoritative.

`Laboratory CI` runs on pull requests and pushes to `main` with read-only repository permissions. It performs a deterministic Node 24 install, all tests, high-severity production dependency audit, JS and shell syntax checks, synthetic signed bootstrap tests, rendered Compose and pre-start gateway checks, and the pinned Part 12 catalog/evidence gate. CI also builds and smoke-tests a disposable image. Release qualification separately builds the candidate image once, then smoke-tests and promotes that exact digest.

`Release Laboratory` runs only for `laboratory-vX.Y.Z`. The version sequence
starts at `0.0.1`; a plain `v0.0.1`-style tag runs verification-only CI and
cannot publish or mutate a release. The qualified tag version must equal
`services/api/package.json`. The workflow builds and pushes one candidate image
with SBOM and provenance, smoke-tests that exact registry digest, then promotes
the same digest to the exact semantic image tag. The protected signing
job alone receives Laboratory's private release key from GitHub Secrets. It
signs the updater manifest, derives the public counterpart and embeds only that
public key in the versioned `bootstrap.sh`; no private key may enter an
artifact, cache or log. CI verifies that bootstrap provisions
`/etc/exocortex/release-trust/laboratory.pem`, that the manifest signature and
compose checksum fail closed, attests every release artifact and creates the
immutable GitHub release. The candidate is first published as a prerelease; an anonymous re-download checks exact assets, signature, embedded public key and remote tag before the final Part 12 gate permits stable discovery. No production activation is inferred from this CI result.

Required branch protection for `main`:

- pull request required;
- `Laboratory CI / verify` required and up to date;
- force pushes and branch deletion disabled;
- at least one review for external changes;
- tag creation restricted to release operators.

Release procedure:

1. Set the package version and update release notes/documentation.
2. Merge a green pull request.
3. Create an annotated `laboratory-vX.Y.Z` tag from the protected commit.
4. Confirm candidate smoke, digest promotion, artifact attestation and GitHub release.
5. Run a clean bootstrap smoke that starts from the embedded public key,
   creates Laboratory's own `.env`, rejects an invalid manifest before any
   service download, and requires no `scp` or manual release-key fingerprint.
6. Run the backup/restore drill before broad deployment.
