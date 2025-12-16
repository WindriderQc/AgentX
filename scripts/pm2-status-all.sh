#!/usr/bin/env bash
set -euo pipefail

echo "=== PM2 (current user: $(whoami)) ==="
pm2 status || true

echo

echo "=== PM2 (deployed DataAPI user: dataapi) ==="
# If sudo requires a password on this VM, run once in an interactive shell:
#   sudo -v
sudo -u dataapi pm2 status || true
