#!/usr/bin/env bash
set -euo pipefail

version="${1:?version is required}"
output="${2:-release-artifacts}"
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
repository="${GITHUB_REPOSITORY:?GITHUB_REPOSITORY is required}"
image_reference="${IMAGE_REFERENCE:?IMAGE_REFERENCE is required}"
image_digest="${IMAGE_DIGEST:?IMAGE_DIGEST is required}"
updater_dir="${UPDATER_BUNDLE_DIR:?UPDATER_BUNDLE_DIR is required}"
updater_version="${UPDATER_BUNDLE_VERSION:?UPDATER_BUNDLE_VERSION is required}"
pinned_updater_version="$(tr -d '[:space:]' < "$root/.release/updater.version")"

[[ "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+([.-][0-9A-Za-z.-]+)?$ ]] || exit 2
[[ "$image_digest" =~ ^sha256:[a-f0-9]{64}$ ]] || exit 3
[[ "$updater_version" == "$pinned_updater_version" ]] || {
  echo "Updater bundle version $updater_version does not match pin $pinned_updater_version" >&2
  exit 4
}
[[ -f "$updater_dir/install.sh" && -f "$updater_dir/updater-linux-amd64" && -f "$updater_dir/systemd/updater.service" ]] || {
  echo "Verified Updater install bundle is incomplete" >&2
  exit 5
}

mkdir -p "$root/$output"
stage="$(mktemp -d)"
trap 'rm -rf "$stage"' EXIT
cp "$root/compose.production.yaml" "$root/compose.updater.yaml" \
  "$root/.env.example" "$root/README.md" "$root/install.sh" "$stage/"
cp -R "$updater_dir" "$stage/updater"
find "$stage/updater" -type f -name '*.sh' -exec chmod 0755 {} +
chmod 0755 "$stage/install.sh" "$stage/updater/updater-linux-amd64"
sed -i \
  -e "s|^LABORATORY_VERSION=.*|LABORATORY_VERSION=$version|" \
  -e "s|^LABORATORY_IMAGE=.*|LABORATORY_IMAGE=${image_reference}@${image_digest}|" \
  "$stage/.env.example"

bundle="$root/$output/laboratory-${version}-compose.tar.gz"
tar -czf "$bundle" -C "$stage" .
bundle_sha="$(sha256sum "$bundle" | awk '{print $1}')"
printf '%s  %s\n' "$bundle_sha" "$(basename "$bundle")" > "$bundle.sha256"
install -m 0755 "$root/scripts/bootstrap.sh" "$root/$output/bootstrap.sh"
cat > "$root/$output/laboratory-release.json" <<EOF
{
  "schema_version": 1,
  "service": "laboratory",
  "component_role": "publication-head",
  "version": "$version",
  "image": {
    "reference": "$image_reference",
    "digest": "$image_digest"
  },
  "compose_bundle": {
    "url": "https://github.com/${repository}/releases/download/laboratory-v${version}/laboratory-${version}-compose.tar.gz",
    "sha256": "$bundle_sha"
  },
  "minimum_updater_version": "$updater_version",
  "database_schema": 6,
  "backup_schema": "exocortex.laboratory.backup.v3",
  "compose_contract": 2,
  "release_notes_url": "https://github.com/${repository}/releases/tag/laboratory-v${version}"
}
EOF
