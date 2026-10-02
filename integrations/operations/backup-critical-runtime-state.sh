#!/usr/bin/env bash
set -Eeuo pipefail

# Complements Core's Mongo/config/Qdrant backups with explicitly selected native
# Docker volumes and an optional transactional MySQL dump. Instance selections
# belong in the supervisor's external environment file, never in this script.

umask 077

backup_root="${BACKUP_ROOT:?Set BACKUP_ROOT to an external absolute directory}"
[[ "$backup_root" == /* ]] || { printf 'BACKUP_ROOT must be absolute\n' >&2; exit 2; }
output_dir="${backup_root}/volumes"
retention_days="${CRITICAL_BACKUP_RETENTION_DAYS:-30}"
archive_image="${VOLUME_ARCHIVE_IMAGE:-alpine:3.20}"
mysql_container="${CRITICAL_BACKUP_MYSQL_CONTAINER:-}"
stamp="$(date -u +%Y%m%dT%H%M%SZ)"

read -r -a volumes <<< "${CRITICAL_BACKUP_VOLUMES:?Set CRITICAL_BACKUP_VOLUMES to a space-separated volume list}"
for volume in "${volumes[@]}"; do
  [[ "$volume" =~ ^[A-Za-z0-9][A-Za-z0-9_.-]*$ ]] || { printf 'Invalid volume name\n' >&2; exit 2; }
done
[[ ${#volumes[@]} -gt 0 ]] || { printf 'At least one volume is required\n' >&2; exit 2; }
if [[ -n "$mysql_container" && ! "$mysql_container" =~ ^[A-Za-z0-9][A-Za-z0-9_.-]*$ ]]; then
  printf 'Invalid MySQL container name\n' >&2; exit 2
fi

mkdir -p -- "$output_dir"
output_dir="$(cd "$output_dir" && pwd -P)"
target="${output_dir}/critical-volumes-${stamp}.tar.gz"
partial="${target}.partial"
staging="$(mktemp -d "${output_dir}/.critical-backup.XXXXXX")"

cleanup() {
  case "$partial" in
    "${output_dir}"/critical-volumes-*.tar.gz.partial) rm -f -- "$partial" ;;
    *) printf 'Refusing unsafe partial cleanup: %s\n' "$partial" >&2 ;;
  esac
  case "$staging" in
    "${output_dir}"/.critical-backup.*) rm -rf -- "$staging" ;;
    *) printf 'Refusing unsafe staging cleanup: %s\n' "$staging" >&2 ;;
  esac
}
trap cleanup EXIT

if [[ -e "$target" || -e "$partial" ]]; then
  printf 'Backup target already exists for this timestamp: %s\n' "$target" >&2
  exit 1
fi

for volume in "${volumes[@]}"; do
  docker volume inspect "$volume" >/dev/null
done
if [[ -n "$mysql_container" ]]; then
  docker inspect --type container "$mysql_container" >/dev/null
  if [[ "$(docker inspect -f '{{.State.Running}}' "$mysql_container")" != "true" ]]; then
    printf 'MySQL container is not running: %s\n' "$mysql_container" >&2
    exit 1
  fi
fi

for volume in "${volumes[@]}"; do
  docker run --rm --network none \
    -v "${volume}:/source:ro" \
    -v "${staging}:/dest" \
    "$archive_image" \
    sh -eu -c 'tar -C /source -czf "/dest/$1.tar.gz" .' -- "$volume"
done

if [[ -n "$mysql_container" ]]; then
  docker exec "$mysql_container" sh -eu -c \
    'test -n "$MYSQL_DATABASE"; test -n "$MYSQL_ROOT_PASSWORD"; exec mysqldump --single-transaction --routines --events --triggers --hex-blob -uroot -p"$MYSQL_ROOT_PASSWORD" "$MYSQL_DATABASE"' \
    | gzip -9 > "${staging}/mysql.logical.sql.gz"
  gzip -t "${staging}/mysql.logical.sql.gz"
  gzip -dc "${staging}/mysql.logical.sql.gz" \
    | awk '/^CREATE TABLE/{found=1} END{exit !found}'
fi

cat > "${staging}/manifest.txt" <<EOF
schema_version=2
created_at=${stamp}
source_host=$(hostname)
mysql_container=${mysql_container}
mysql_dump=$([[ -n "$mysql_container" ]] && printf logical_mysql_dump || printf none)
volume_count=${#volumes[@]}
volumes=$(IFS=,; printf '%s' "${volumes[*]}")
EOF

(
  cd "$staging"
  shopt -s nullglob
  sha256sum -- manifest.txt ./*.tar.gz ./*.sql.gz > SHA256SUMS
)

tar -C "$staging" -czf "$partial" .
mv -- "$partial" "$target"
sha256sum -- "$target" > "${target}.sha256"

if [[ "$retention_days" =~ ^[0-9]+$ ]]; then
  while IFS= read -r -d '' candidate; do
    name="$(basename "$candidate")"
    if [[ "$name" =~ ^critical-volumes-[0-9]{8}T[0-9]{6}Z\.tar\.gz(\.sha256)?$ ]]; then
      rm -f -- "$candidate"
    else
      printf 'Refusing unexpected retention candidate: %s\n' "$candidate" >&2
      exit 1
    fi
  done < <(find "$output_dir" -maxdepth 1 -type f \
    \( -name 'critical-volumes-*.tar.gz' -o -name 'critical-volumes-*.tar.gz.sha256' \) \
    -mtime "+${retention_days}" -print0)
fi

printf '{"status":"created","archive":"%s","bytes":%s,"sha256":"%s"}\n' \
  "$target" \
  "$(stat -c '%s' "$target")" \
  "$(sha256sum "$target" | awk '{print $1}')"
