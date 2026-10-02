#!/usr/bin/env bash
set -Eeuo pipefail
# Runs only against disposable resources; no instance configuration is loaded.
root="$(cd "$(dirname "$0")/../../.." && pwd -P)"
workdir="$(mktemp -d)"
volume="agentx-backup-test-$$"
mysql="agentx-backup-test-mysql-$$"
cleanup() {
  docker rm -fv "$mysql" >/dev/null 2>&1 || true
  docker volume rm "$volume" >/dev/null 2>&1 || true
  [[ -d "$workdir" && "$workdir" == /tmp/* ]] && rm -rf -- "$workdir"
}
trap cleanup EXIT
export VOLUME_ARCHIVE_IMAGE=alpine:3.20
export MYSQL_DRILL_IMAGE=mysql:8.4
export CRITICAL_BACKUP_VOLUMES="$volume"
docker volume create "$volume" >/dev/null
docker run --rm --network none -v "$volume:/fixture" "$VOLUME_ARCHIVE_IMAGE" \
  sh -eu -c 'mkdir /fixture/nested; printf "synthetic backup content\n" > /fixture/nested/evidence.txt'
docker run -d --name "$mysql" --network none -e MYSQL_ROOT_PASSWORD=synthetic-ci-password \
  -e MYSQL_DATABASE=fixture "$MYSQL_DRILL_IMAGE" --skip-log-bin >/dev/null
ready=false
for _attempt in $(seq 1 60); do
  if docker exec "$mysql" mysql --protocol=TCP -h127.0.0.1 -uroot -psynthetic-ci-password -e 'SELECT 1' >/dev/null 2>&1; then
    ready=true; break
  fi
  sleep 2
done
[[ "$ready" == true ]]
docker exec "$mysql" mysql -uroot -psynthetic-ci-password fixture \
  -e "CREATE TABLE evidence (id INT PRIMARY KEY, content TEXT); INSERT INTO evidence VALUES (1, 'synthetic database content');"
export BACKUP_ROOT="$workdir/full"
export CRITICAL_BACKUP_MYSQL_CONTAINER="$mysql"
bash "$root/integrations/operations/backup-critical-runtime-state.sh"
archive="$(find "$BACKUP_ROOT/volumes" -name '*.tar.gz' -type f)"
bash "$root/integrations/operations/restore-drill-critical-runtime-state.sh" "$archive" | tee "$workdir/full-receipt"
grep -q '"restoredVolumes":1,"mysqlTables":1' "$workdir/full-receipt"

# Legacy archives keep the previous logical dump filename and do not checksum
# their manifest. They must remain usable during and after the cutover.
mkdir "$workdir/legacy"
tar -C "$workdir/legacy" -xzf "$archive"
mv "$workdir/legacy/mysql.logical.sql.gz" "$workdir/legacy/leantime_db_data.logical.sql.gz"
sed -i 's/^schema_version=2$/schema_version=1/;s/^mysql_dump=/leantime_db_data=/' "$workdir/legacy/manifest.txt"
(cd "$workdir/legacy"; sha256sum -- ./*.tar.gz ./*.sql.gz > SHA256SUMS)
tar -C "$workdir/legacy" -czf "$workdir/legacy.tar.gz" .
bash "$root/integrations/operations/restore-drill-critical-runtime-state.sh" "$workdir/legacy.tar.gz" | tee "$workdir/legacy-receipt"
grep -q '"restoredVolumes":1,"mysqlTables":1' "$workdir/legacy-receipt"

export BACKUP_ROOT="$workdir/volumes-only"
unset CRITICAL_BACKUP_MYSQL_CONTAINER
bash "$root/integrations/operations/backup-critical-runtime-state.sh"
volume_archive="$(find "$BACKUP_ROOT/volumes" -name '*.tar.gz' -type f)"
bash "$root/integrations/operations/restore-drill-critical-runtime-state.sh" "$volume_archive" | tee "$workdir/volumes-receipt"
grep -q '"restoredVolumes":1,"mysqlTables":0' "$workdir/volumes-receipt"

# A corrupt payload must fail before a successful restore can be claimed.
mkdir "$workdir/corrupt"
tar -C "$workdir/corrupt" -xzf "$volume_archive"
printf 'corrupted' >> "$workdir/corrupt/$volume.tar.gz"
tar -C "$workdir/corrupt" -czf "$workdir/corrupt.tar.gz" .
if bash "$root/integrations/operations/restore-drill-critical-runtime-state.sh" "$workdir/corrupt.tar.gz"; then
  printf 'Corrupt archive was accepted\n' >&2; exit 1
fi
# The source remains intact after every drill, including the failed restore.
docker run --rm --network none -v "$volume:/fixture:ro" "$VOLUME_ARCHIVE_IMAGE" \
  sh -eu -c 'test "$(cat /fixture/nested/evidence.txt)" = "synthetic backup content"'
[[ "$(docker exec "$mysql" mysql -N -uroot -psynthetic-ci-password fixture -e 'SELECT COUNT(*) FROM evidence')" == 1 ]]
if docker volume ls --format '{{.Name}}' | grep -q '^agentx-restore-drill-'; then
  printf 'Restore drill leaked a disposable volume\n' >&2; exit 1
fi
printf 'Backup, legacy restore, volume-only restore and corruption rejection passed\n'
