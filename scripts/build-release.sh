#!/usr/bin/env bash
set -euo pipefail

version="${1:?version is required}"
output="${2:-release-artifacts}"
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$root"
case "$output" in /*) ;; *) output="$root/$output" ;; esac
repository="${GITHUB_REPOSITORY:?GITHUB_REPOSITORY is required}"
image_reference="${IMAGE_REFERENCE:?IMAGE_REFERENCE is required}"
image_digest="${IMAGE_DIGEST:?IMAGE_DIGEST is required}"
updater_dir="${UPDATER_BUNDLE_DIR:?UPDATER_BUNDLE_DIR is required}"
wyvern_dir="${WYVERN_BUNDLE_DIR:?WYVERN_BUNDLE_DIR with signed manifest is required}"
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

mkdir -p "$output"
public_key="${RELEASE_PUBLIC_KEY_FILE:-$output/laboratory.pem}"
[[ -f "$public_key" ]] || { echo 'Export the release public key before building' >&2; exit 6; }
for scope in updater neptune gryphon wyvern; do
  [[ -f "$updater_dir/release-trust/$scope.pem" ]] || { echo "Missing signed Updater trust scope $scope" >&2; exit 6; }
done
[[ "$version" == "$(node -p "require('./services/api/package.json').version")" ]] || { echo 'Source/release version mismatch' >&2; exit 6; }
stage="$(mktemp -d)"
trap 'rm -rf "$stage"' EXIT
cp "$root/compose.production.yaml" "$root/compose.updater.yaml" \
  "$root/.env.example" "$root/README.md" "$root/DEPLOYMENT.md" "$root/nginx.server.example.conf" "$root/install.sh" "$stage/"
cp -R "$updater_dir" "$stage/updater"
"$updater_dir/updater-linux-amd64" wyvern capabilities >/dev/null
python3 "$root/scripts/verify-wyvern-bundle.py" "$wyvern_dir" "$updater_dir/release-trust/wyvern.pem"
mkdir -p "$stage/wyvern"
cp "$wyvern_dir/wyvern-release.json" "$wyvern_dir/wyvern-release.json.sig.json" "$stage/wyvern/"
find "$stage/updater" -type f -name '*.sh' -exec chmod 0755 {} +
chmod 0755 "$stage/install.sh" "$stage/updater/updater-linux-amd64"
sed -i \
  -e "s|^LABORATORY_VERSION=.*|LABORATORY_VERSION=$version|" \
  -e "s|^LABORATORY_IMAGE=.*|LABORATORY_IMAGE=${image_reference}@${image_digest}|" \
  "$stage/.env.example"

bundle="$output/laboratory-${version}-compose.tar.gz"
tar -czf "$bundle" -C "$stage" .
bundle_sha="$(sha256sum "$bundle" | awk '{print $1}')"
printf '%s  %s\n' "$bundle_sha" "$(basename "$bundle")" > "$bundle.sha256"

cat > "$output/laboratory-release.json" <<EOF
{
  "schema_version": 1,
  "service": "laboratory",
  "rollback_restore": "laboratory-offline-v1",
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
  "database_schema": 7,
  "backup_schema": "exocortex.laboratory.backup.v3",
  "compose_contract": 2,
  "release_notes_url": "https://github.com/${repository}/releases/tag/laboratory-v${version}"
}
EOF

node "$root/scripts/build-bootstrap.mjs" "$root/scripts/bootstrap.sh" "$public_key" "$output/bootstrap.sh" "$version"
