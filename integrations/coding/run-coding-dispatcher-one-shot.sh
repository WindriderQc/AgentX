#!/usr/bin/env bash
set -Eeuo pipefail

if [[ $# -gt 1 || ( $# -eq 1 && ! "$1" =~ ^[0-9]{4}$ ) ]]; then
  echo '{"ok":false,"code":"CODING_DISPATCH_INVALID_TASK"}' >&2
  exit 64
fi

readonly task_id="${1:-}"
readonly script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
readonly repo_root="$(cd -- "${script_dir}/../.." && pwd -P)"
readonly default_config="${AGENTX_INSTANCE_ROOT:+${AGENTX_INSTANCE_ROOT}/config/coding-dispatcher.json}"
readonly config_path="${AGENTX_CODING_CONFIG:-${default_config:-${HOME}/.config/agentx/coding-dispatcher.json}}"
readonly ca_path="${AGENTX_CODING_CA_FILE:-}"
readonly state_root="${XDG_STATE_HOME:-${HOME}/.local/state}/agentx"

mkdir -p -- "${state_root}"
chmod 700 -- "${state_root}"
exec 9>"${state_root}/coding-dispatcher-one-shot.lock"
if ! flock -n 9; then
  echo '{"ok":false,"code":"CODING_DISPATCH_BUSY"}' >&2
  exit 75
fi

cd -- "${repo_root}"
if [[ -n "$(git status --porcelain --untracked-files=no)" ]]; then
  echo '{"ok":false,"code":"CODING_DISPATCH_TRACKED_TREE_DIRTY"}' >&2
  exit 78
fi
if [[ -n "${ca_path}" && ! -r "${ca_path}" ]]; then
  echo '{"ok":false,"code":"CODING_DISPATCH_CA_UNAVAILABLE"}' >&2
  exit 78
fi

jq -e '
  .enabled == false
  and .defaultMode == "shadow"
  and .maxConcurrent == 1
  and ([.policies[].requireAuthoritySources] | length > 0 and all(. == true))
  and ([.executionProfiles[].costEvidenceMode] | length > 0 and all(. == "local-zero"))
  and ([.policies[].ceilings.maxCostNanodollars] | length > 0 and all(. == 0))
' "${config_path}" >/dev/null || {
  echo '{"ok":false,"code":"CODING_DISPATCH_POLICY_DRIFT"}' >&2
  exit 78
}

temporary_config="$(mktemp "${TMPDIR:-/tmp}/agentx-coding-dispatch.XXXXXX.json")"
cleanup() {
  rm -f -- "${temporary_config}"
}
trap cleanup EXIT INT TERM
jq '.enabled = true' "${config_path}" > "${temporary_config}"
chmod 600 -- "${temporary_config}"

dispatcher_args=(
  --config "${temporary_config}"
  --mode canary
  --allow-dispatch
)
if [[ -n "${ca_path}" ]]; then dispatcher_args+=(--ca-file "${ca_path}"); fi
if [[ -n "${task_id}" ]]; then
  dispatcher_args+=(--task-id "${task_id}")
else
  dispatcher_args+=(--select-first-admissible)
fi
python3 "${repo_root}/integrations/coding/coding-dispatcher.py" "${dispatcher_args[@]}"
