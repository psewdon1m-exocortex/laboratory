# CI and releases

`Laboratory CI` runs on pull requests and pushes to `main` with read-only repository permissions. It performs a deterministic Node 24 install, all tests, high-severity production dependency audit, JS and shell syntax checks, release-contract construction, production Compose validation, one Docker build and a non-root/read-only container smoke test. Action dependencies are pinned to immutable commit SHAs.

`Release Laboratory` runs only for `laboratory-vX.Y.Z`. The tag version must equal `services/api/package.json`. It builds and pushes one candidate image with SBOM and provenance, smoke-tests that exact registry digest, then promotes the same digest to the semantic and `latest` tags. The workflow generates and verifies the compose bundle, SHA-256 sidecar and updater manifest, attests every release artifact and creates the immutable GitHub release.

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
5. Run a clean bootstrap smoke and backup/restore drill before broad deployment.
