#!/usr/bin/env bash
set -Eeuo pipefail

umask 077

archive="${1:-}"
if [[ -z "$archive" || ! -f "$archive" ]]; then
  printf 'Usage: %s /absolute/path/critical-volumes-<UTC>.tar.gz\n' "$0" >&2
  exit 2
fi
archive="$(cd "$(dirname "$archive")" && pwd -P)/$(basename "$archive")"
archive_image="${VOLUME_ARCHIVE_IMAGE:-alpine:3.20}"
mysql_image="${MYSQL_DRILL_IMAGE:-mysql:8.4}"
drill_id="$(date -u +%Y%m%d%H%M%S)-$$"
mysql_container="agentx-restore-drill-mysql-${drill_id}"
work_root="$(dirname "$archive")"
workdir="$(mktemp -d "${work_root}/.critical-restore-drill.XXXXXX")"
drill_volumes=()

cleanup() {
  docker rm -fv "$mysql_container" >/dev/null 2>&1 || true
  for volume in "${drill_volumes[@]}"; do
    [[ "$volume" == agentx-restore-drill-* ]] && docker volume rm -f "$volume" >/dev/null 2>&1 || true
  done
  case "$workdir" in
    "${work_root}"/.critical-restore-drill.*) rm -rf -- "$workdir" ;;
    *) printf 'Refusing unsafe restore-drill cleanup: %s\n' "$workdir" >&2 ;;
  esac
}
trap cleanup EXIT

# The outer archive contains only regular files with bounded names. Never let a
# supplied manifest or archive select a path outside this disposable directory.
while IFS= read -r member; do
  [[ "$member" =~ ^(\./)?(manifest\.txt|SHA256SUMS|[A-Za-z0-9][A-Za-z0-9_.-]*\.(tar|sql)\.gz)$ || "$member" == ./ ]] || {
    printf 'Unexpected archive member\n' >&2; exit 2;
  }
done < <(tar -tzf "$archive")
if tar -tvzf "$archive" | awk 'substr($0,1,1)!="-" && substr($0,1,1)!="d"{bad=1} END{exit !bad}'; then
  printf 'Archive contains a non-regular member\n' >&2; exit 2
fi
tar -C "$workdir" --no-same-owner --no-same-permissions -xzf "$archive"
# Validate checksum paths before sha256sum can read them. Version 1 archives did
# not checksum the manifest; they remain readable for rollback.
# Older host awk implementations do not support interval expressions ({64}).
# Check the digest length separately while retaining the strict path allowlist.
awk 'length($1)!=64 || !/^[0-9a-f]+  (\.\/)?(manifest\.txt|[A-Za-z0-9][A-Za-z0-9_.-]*\.(tar|sql)\.gz)$/{bad=1} END{exit bad}' "$workdir/SHA256SUMS"
(
  cd "$workdir"
  sha256sum -c SHA256SUMS
)

volume_list="$(sed -n 's/^volumes=//p' "$workdir/manifest.txt")"
[[ "$volume_list" =~ ^[A-Za-z0-9][A-Za-z0-9_.-]*(,[A-Za-z0-9][A-Za-z0-9_.-]*)*$ ]] || {
  printf 'Invalid volume list in manifest\n' >&2; exit 2;
}
IFS=, read -r -a source_volumes <<< "$volume_list"
declared_count="$(sed -n 's/^volume_count=//p' "$workdir/manifest.txt")"
[[ "$declared_count" == "${#source_volumes[@]}" ]] || { printf 'Volume count mismatch\n' >&2; exit 2; }

for source_volume in "${source_volumes[@]}"; do
  source_archive="${workdir}/${source_volume}.tar.gz"
  [[ -s "$source_archive" ]]
  target_volume="agentx-restore-drill-${drill_id}-${#drill_volumes[@]}"
  docker volume create "$target_volume" >/dev/null
  drill_volumes+=("$target_volume")
  docker run --rm --network none \
    -v "${target_volume}:/restore" \
    -v "${workdir}:/source:ro" \
    "$archive_image" \
    sh -eu -c 'tar -C /restore -xzf "/source/$1.tar.gz"' -- "$source_volume"
  if tar -tzf "$source_archive" | awk '$0 !~ /^\.\/?$/{found=1} END{exit !found}'; then
    docker run --rm --network none -v "${target_volume}:/restore:ro" "$archive_image" \
      sh -eu -c 'find /restore -mindepth 1 -print -quit | grep -q .'
  fi
done

table_count=0
sql_archive="${workdir}/mysql.logical.sql.gz"
# Keep existing operator rollback archives usable.
[[ -f "$sql_archive" ]] || sql_archive="${workdir}/leantime_db_data.logical.sql.gz"
if [[ -f "$sql_archive" ]]; then
gzip -t "$sql_archive"
drill_password="$(openssl rand -hex 24)"
docker run -d --name "$mysql_container" --network none \
  -e MYSQL_ROOT_PASSWORD="$drill_password" \
  -e MYSQL_DATABASE=restore_drill \
  "$mysql_image" --skip-log-bin >/dev/null

ready=false
for _attempt in $(seq 1 60); do
  # The image's temporary initialization server accepts socket queries before
  # restarting. TCP becomes available only on the final server.
  if docker exec "$mysql_container" mysql --protocol=TCP -h127.0.0.1 -N -uroot -p"$drill_password" \
    -e 'SELECT 1' >/dev/null 2>&1; then
    ready=true
    break
  fi
  sleep 2
done
if [[ "$ready" != true ]]; then
  printf 'Disposable MySQL did not become ready\n' >&2
  exit 1
fi

gzip -dc "$sql_archive" | docker exec -i "$mysql_container" \
  mysql -uroot -p"$drill_password" restore_drill
table_count="$(docker exec "$mysql_container" mysql -N -uroot -p"$drill_password" \
  -e "SELECT COUNT(*) FROM information_schema.tables WHERE table_schema='restore_drill';")"
if [[ ! "$table_count" =~ ^[0-9]+$ || "$table_count" -lt 1 ]]; then
  printf 'Disposable MySQL restore contained no tables\n' >&2
  exit 1
fi
elif grep -Eq '^(mysql_dump|leantime_db_data)=logical_mysql_dump$' "$workdir/manifest.txt"; then
  printf 'Manifest requires a missing logical MySQL dump\n' >&2; exit 1
fi

printf '{"status":"passed","archive":"%s","restoredVolumes":%s,"mysqlTables":%s}\n' \
  "$archive" "${#source_volumes[@]}" "$table_count"
