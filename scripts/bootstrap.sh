#!/bin/sh
set -eu

repository="psewdon1m-exocortex/laboratory"
target="/opt/exocortex/laboratory"
version=""

fail() {
  printf '%s\n' "laboratory bootstrap: $*" >&2
  exit 1
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --version) [ "$#" -ge 2 ] || fail "--version requires a value"; version=$2; shift 2 ;;
    *) fail "unknown argument: $1" ;;
  esac
done
printf '%s' "$version" | grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+([.-][0-9A-Za-z.-]+)?$' || fail "pass --version X.Y.Z"
[ "$(id -u)" -eq 0 ] || fail "run as root"
command -v curl >/dev/null 2>&1 || fail "curl is required"
command -v sha256sum >/dev/null 2>&1 || fail "sha256sum is required"
command -v tar >/dev/null 2>&1 || fail "tar is required"

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT HUP INT TERM
base="https://github.com/$repository/releases/download/laboratory-v$version"
bundle="laboratory-$version-compose.tar.gz"
curl -fL --proto '=https' --tlsv1.2 --retry 3 --max-time 300 -o "$work/$bundle" "$base/$bundle"
curl -fL --proto '=https' --tlsv1.2 --retry 3 --max-time 60 -o "$work/$bundle.sha256" "$base/$bundle.sha256"
(cd "$work" && sha256sum -c "$bundle.sha256")

members="$work/members.txt"
tar -tzf "$work/$bundle" > "$members"
count=$(wc -l < "$members" | tr -d ' ')
[ "$count" -le 256 ] || fail "release bundle contains too many members"
awk '
  /^\// { exit 1 }
  /(^|\/)\.\.($|\/)/ { exit 1 }
  /\\/ { exit 1 }
  { if (seen[$0]++) exit 1 }
' "$members" || fail "release bundle contains an unsafe or duplicate path"

stage="$work/stage"
mkdir -p "$stage"
tar -xzf "$work/$bundle" -C "$stage" --no-same-owner --no-same-permissions
for name in compose.production.yaml .env.example README.md install.sh; do
  [ -f "$stage/$name" ] || fail "release bundle is missing $name"
done
mkdir -p "$target"
chmod 0750 "$target"
for name in compose.production.yaml compose.updater.yaml .env.example README.md install.sh; do
  [ -f "$stage/$name" ] && install -m 0644 "$stage/$name" "$target/$name"
done
chmod 0755 "$target/install.sh"
if [ ! -f "$target/.env" ]; then
  install -m 0600 "$target/.env.example" "$target/.env"
fi
printf '%s\n' \
  "Release $version is verified and staged in $target." \
  "Edit only the OPERATOR INPUT values in $target/.env; replace every CHANGE_ME." \
  "Then run: sudo $target/install.sh"
