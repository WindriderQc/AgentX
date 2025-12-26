#!/usr/bin/env bash
set -euo pipefail

# Manage the deployed DataAPI PM2 daemon (owned by the `dataapi` Linux user).
# This keeps operations consistent from the `yb` account.
#
# Examples:
#   ./scripts/pm2-dataapi.sh status
#   ./scripts/pm2-dataapi.sh logs DataAPI --lines 200
#   ./scripts/pm2-dataapi.sh restart DataAPI --update-env

if ! command -v pm2 >/dev/null 2>&1; then
  echo "pm2 not found in PATH" >&2
  exit 127
fi

exec sudo -u dataapi pm2 "$@"
