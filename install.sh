#!/bin/sh
set -eu

action="${1:-install}"
service_id="laboratory"
target="${LABORATORY_INSTALL_DIR:-/opt/exocortex/laboratory}"
script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
env_file="$target/.env"

fail() {
  printf '%s\n' "laboratory install: $*" >&2
  exit 1
}

get_env() {
  sed -n "s/^$1=//p" "$env_file" | tail -n 1
}

get_env_from() {
  source_file=$1; source_key=$2
  sed -n "s/^$source_key=//p" "$source_file" | tail -n 1
}

set_env() {
  key=$1; value=$2; temporary="$env_file.tmp"
  awk -v key="$key" -v value="$value" 'BEGIN { found=0 } index($0,key "=")==1 { print key "=" value; found=1; next } { print } END { if (!found) print key "=" value }' "$env_file" >"$temporary"
  chmod 0600 "$temporary"; mv -f "$temporary" "$env_file"
}

needs_generation() {
  current=$(get_env "$1")
  case "$current" in
    ""|CHANGE_ME*|change-*|replace-*) return 0 ;;
    *) return 1 ;;
  esac
}

random_hex() {
  openssl rand -hex "$1"
}

copy_local_kernel_bootstrap() {
  kernel_env=/opt/exocortex/kernel/.env
  [ -r "$kernel_env" ] || return 0
  current_url=$(get_env KERNEL_URL)
  current_token=$(get_env KERNEL_SERVICE_TOKEN)
  case "$current_url" in ""|*CHANGE_ME*|*replace-me*|*.example.*)
    local_url=$(get_env_from "$kernel_env" KERNEL_URL)
    [ -n "$local_url" ] && set_env KERNEL_URL "$local_url"
    ;;
  esac
  case "$current_token" in ""|CHANGE_ME*|change-*|replace-*)
    local_token=$(get_env_from "$kernel_env" KERNEL_SERVICE_TOKEN)
    [ -n "$local_token" ] && set_env KERNEL_SERVICE_TOKEN "$local_token"
    ;;
  esac
}

install_command() {
  install -d -m 0755 /usr/local/sbin
  {
    printf '%s\n' '#!/bin/sh'
    printf 'exec "%s/install.sh" "$@"\n' "$target"
  } > /usr/local/sbin/laboratory-install
  chmod 0755 /usr/local/sbin/laboratory-install
}

copy_release_files() {
  mkdir -p "$target"
  chmod 0750 "$target"
  for name in compose.production.yaml compose.updater.yaml .env.example README.md install.sh; do
    [ -f "$script_dir/$name" ] || fail "release bundle is missing $name"
    if [ "$script_dir/$name" != "$target/$name" ]; then
      install -m 0644 "$script_dir/$name" "$target/$name"
    fi
  done
  chmod 0755 "$target/install.sh"

  for name in install.sh updater-linux-amd64 systemd/updater.service; do
    [ -f "$script_dir/updater/$name" ] || fail "release bundle is missing updater/$name"
  done
  if [ "$script_dir" != "$target" ]; then
    install -d -m 0755 "$target/updater/systemd"
    install -m 0755 "$script_dir/updater/install.sh" "$script_dir/updater/updater-linux-amd64" "$target/updater/"
    install -m 0644 "$script_dir/updater/systemd/updater.service" "$target/updater/systemd/updater.service"
  fi
}

prepare_updater_mount() {
  getent group updater >/dev/null 2>&1 || groupadd --system updater
  updater_gid=$(getent group updater | cut -d: -f3)
  install -d -o root -g updater -m 0770 /run/exocortex
  set_env UPDATER_SOCKET_GID "$updater_gid"
  set_env UPDATER_COMPOSE_PROJECT_DIR "$target"
}

prepare_neptune_mounts() {
  getent group neptune-clients >/dev/null 2>&1 || groupadd --system neptune-clients
  neptune_gid=$(getent group neptune-clients | cut -d: -f3)
  install -d -o root -g neptune-clients -m 0770 /run/neptune
  install -d -o root -g neptune-clients -m 0750 /etc/neptune/clients
  for token_file in /etc/neptune/clients/laboratory.control.token /etc/neptune/clients/laboratory.export.token; do
    if [ ! -s "$token_file" ]; then umask 0027; random_hex 32 >"$token_file"; fi
    chown root:neptune-clients "$token_file"; chmod 0640 "$token_file"
  done
  set_env NEPTUNE_SOCKET_GID "$neptune_gid"
  set_env NEPTUNE_CONTROL_TOKEN_HOST_FILE /etc/neptune/clients/laboratory.control.token
  set_env NEPTUNE_EXPORT_TOKEN_HOST_FILE /etc/neptune/clients/laboratory.export.token
}

prepare_config() {
  command -v openssl >/dev/null 2>&1 || fail "openssl is not installed"
  created=0
  if [ ! -f "$env_file" ]; then
    install -m 0600 "$target/.env.example" "$env_file"
    created=1
  fi
  chmod 0600 "$env_file"
  needs_generation LABORATORY_SESSION_SECRET && set_env LABORATORY_SESSION_SECRET "$(random_hex 32)"
  needs_generation UPDATER_CONTROL_TOKEN && set_env UPDATER_CONTROL_TOKEN "$(random_hex 32)"
  copy_local_kernel_bootstrap
  prepare_updater_mount
  prepare_neptune_mounts
  install_command
}

validate_install() {
  command -v docker >/dev/null 2>&1 || fail "Docker is not installed"
  docker compose version >/dev/null 2>&1 || fail "Docker Compose v2 is not installed"
  [ -f "$env_file" ] || fail "run laboratory-install prepare first"
  mode=$(stat -c '%a' "$env_file" 2>/dev/null || true)
  [ "$mode" = "600" ] || fail "$env_file must have mode 0600"
  if grep -Eq '(^|=).*CHANGE_ME' "$env_file"; then
    fail "$env_file still contains CHANGE_ME placeholders"
  fi
  image=$(get_env LABORATORY_IMAGE)
  case "$image" in
    *@sha256:????????????????????????????????????????????????????????????????) ;;
    *) fail "LABORATORY_IMAGE must be pinned by a sha256 digest" ;;
  esac
}

install_release() {
  validate_install
  "$target/updater/install.sh" "$service_id" "$env_file" "$target/updater/updater-linux-amd64"
  socket_dir=$(get_env UPDATER_SOCKET_DIR); socket_dir=${socket_dir:-/run/exocortex}
  socket_attempt=0
  while [ ! -S "$socket_dir/updater.sock" ] && [ "$socket_attempt" -lt 10 ]; do
    socket_attempt=$((socket_attempt + 1))
    sleep 1
  done
  [ -S "$socket_dir/updater.sock" ] || fail "updater socket is unavailable at $socket_dir/updater.sock"
  docker compose --env-file "$env_file" -f "$target/compose.production.yaml" config --quiet
  docker compose --env-file "$env_file" -f "$target/compose.production.yaml" up -d --remove-orphans

  port=$(get_env LABORATORY_LISTEN_PORT); port=${port:-18380}
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
    docker compose --env-file "$env_file" -f "$target/compose.production.yaml" ps >&2 || true
    docker compose --env-file "$env_file" -f "$target/compose.production.yaml" logs --tail 120 laboratory >&2 || true
    fail "health check did not pass"
  fi
  printf '%s\n' "Laboratory is healthy on http://127.0.0.1:$port and registered with updater."
}

enable_backup() {
  command -v updater >/dev/null 2>&1 || fail "Updater is not installed; run laboratory-install first"
  prepare_neptune_mounts
  updater neptune install --head laboratory
  enrollment_code=${NEPTUNE_ENROLLMENT_CODE:-}
  if [ -z "$enrollment_code" ]; then printf 'Saturn one-time setup code: ' >&2; stty -echo; trap 'stty echo' EXIT HUP INT TERM; IFS= read -r enrollment_code; stty echo; trap - EXIT HUP INT TERM; printf '\n' >&2; fi
  port=$(get_env LABORATORY_LISTEN_PORT); port=${port:-18380}
  printf '%s\n' "$enrollment_code" | updater neptune enroll --head laboratory --project laboratory --export-url "http://127.0.0.1:$port/api/internal/neptune/backup"
  unset enrollment_code
  printf '%s\n' "Laboratory automatic backup is connected. Enable its schedule in Settings."
}

[ "$(id -u)" -eq 0 ] || fail "run as root"
case "$target" in
  /opt/exocortex/laboratory) ;;
  *) fail "LABORATORY_INSTALL_DIR must be /opt/exocortex/laboratory" ;;
esac
case "$action" in prepare|install|status|backup) ;; *) fail "usage: laboratory-install [install|prepare|status|backup]" ;; esac

copy_release_files
case "$action" in
  prepare)
    prepare_config
    printf '%s\n' "Prepared $env_file (mode 0600)." "Edit only the OPERATOR INPUT section, then run: sudo laboratory-install"
    ;;
  install)
    prepare_config
    if [ "$created" -eq 1 ]; then
      printf '%s\n' "Prepared $env_file (mode 0600)." "Edit only the OPERATOR INPUT section, then run: sudo laboratory-install"
      exit 2
    fi
    install_release
    ;;
  status)
    validate_install
    docker compose --env-file "$env_file" -f "$target/compose.production.yaml" ps
    ;;
  backup)
    [ -f "$env_file" ] || fail "install Laboratory first"
    enable_backup
    ;;
esac
