#!/bin/sh
set -eu

service_id="laboratory"
target="${LABORATORY_INSTALL_DIR:-/opt/exocortex/laboratory}"
script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)

fail() {
  printf '%s\n' "laboratory install: $*" >&2
  exit 1
}

[ "$(id -u)" -eq 0 ] || fail "run as root"
case "$target" in
  /opt/exocortex/laboratory) ;;
  *) fail "LABORATORY_INSTALL_DIR must be /opt/exocortex/laboratory" ;;
esac

command -v docker >/dev/null 2>&1 || fail "Docker is not installed"
docker compose version >/dev/null 2>&1 || fail "Docker Compose v2 is not installed"
command -v updater >/dev/null 2>&1 || fail "Exocortex updater 0.2.0 or newer must be installed first"

mkdir -p "$target"
chmod 0750 "$target"
for name in compose.production.yaml compose.updater.yaml .env.example README.md install.sh; do
  [ -f "$script_dir/$name" ] || fail "release bundle is missing $name"
  if [ "$script_dir/$name" != "$target/$name" ]; then
    install -m 0644 "$script_dir/$name" "$target/$name"
  fi
done
chmod 0755 "$target/install.sh"

if [ ! -f "$target/.env" ]; then
  install -m 0600 "$target/.env.example" "$target/.env"
  printf '%s\n' \
    "Prepared $target/.env (mode 0600)." \
    "Set the values in the OPERATOR INPUT section, replace every CHANGE_ME," \
    "then run: sudo $target/install.sh"
  exit 2
fi

mode=$(stat -c '%a' "$target/.env" 2>/dev/null || true)
[ "$mode" = "600" ] || fail "$target/.env must have mode 0600"
if grep -Eq '(^|=).*CHANGE_ME' "$target/.env"; then
  fail "$target/.env still contains CHANGE_ME placeholders"
fi

image=$(sed -n 's/^LABORATORY_IMAGE=//p' "$target/.env" | tail -n 1)
case "$image" in
  *@sha256:????????????????????????????????????????????????????????????????) ;;
  *) fail "LABORATORY_IMAGE must be pinned by a sha256 digest" ;;
esac

socket_dir=$(sed -n 's/^UPDATER_SOCKET_DIR=//p' "$target/.env" | tail -n 1)
[ -n "$socket_dir" ] || socket_dir=/run/exocortex
socket_path="$socket_dir/updater.sock"
[ -S "$socket_path" ] || fail "updater socket is unavailable at $socket_path"
socket_gid=$(stat -c '%g' "$socket_path")
temporary="$target/.env.install.$$"
awk -v gid="$socket_gid" '
  BEGIN { replaced=0 }
  /^UPDATER_SOCKET_GID=/ { print "UPDATER_SOCKET_GID=" gid; replaced=1; next }
  { print }
  END { if (!replaced) print "UPDATER_SOCKET_GID=" gid }
' "$target/.env" > "$temporary"
chmod 0600 "$temporary"
mv -f "$temporary" "$target/.env"

docker compose --env-file "$target/.env" -f "$target/compose.production.yaml" config --quiet
updater register-head "$service_id" "$target/.env"
docker compose --env-file "$target/.env" -f "$target/compose.production.yaml" up -d --remove-orphans

port=$(sed -n 's/^LABORATORY_LISTEN_PORT=//p' "$target/.env" | tail -n 1)
[ -n "$port" ] || port=18380
healthy=0
attempt=0
while [ "$attempt" -lt 60 ]; do
  if command -v curl >/dev/null 2>&1; then
    if curl -fsS --max-time 3 "http://127.0.0.1:$port/api/health" >/dev/null 2>&1; then healthy=1; break; fi
  elif wget -q -T 3 -O /dev/null "http://127.0.0.1:$port/api/health"; then
    healthy=1
    break
  fi
  attempt=$((attempt + 1))
  sleep 2
done
if [ "$healthy" -ne 1 ]; then
  docker compose --env-file "$target/.env" -f "$target/compose.production.yaml" ps >&2 || true
  docker compose --env-file "$target/.env" -f "$target/compose.production.yaml" logs --tail 120 laboratory >&2 || true
  fail "health check did not pass"
fi

printf '%s\n' "Laboratory is healthy on http://127.0.0.1:$port and registered with updater."
