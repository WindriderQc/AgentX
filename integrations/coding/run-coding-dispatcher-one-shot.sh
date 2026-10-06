#!/usr/bin/env bash
set -Eeuo pipefail
readonly script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
exec python3 "${script_dir}/coding_run.py" "$@"
