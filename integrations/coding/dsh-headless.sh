#!/usr/bin/env bash
# Run one bounded DSH task in an isolated, single-capacity local lane.
set -euo pipefail
umask 077

BASE="$HOME/dsh-workspaces"
STATE="$BASE/.agentx"
RUNS="$STATE/runs"
RECEIPTS="$STATE/receipts"
LOCK="${AGENTX_MODEL_LIFECYCLE_LOCK_FILE:-$HOME/.local/state/agentx/model-lifecycle/local-inference.lock}"
DSH_ROOT="$HOME/dsh"
DSH="$DSH_ROOT/node_modules/.bin/dsh"
SETTINGS="$HOME/.dsh/settings.yaml"
INTEGRATION_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
CLAIM_WRAPPER="${AGENTX_CLAIM_WRAPPER:-$INTEGRATION_ROOT/with-agentx-claim.js}"
CLAIM_CORE="${AGENTX_CORE_URL:-http://127.0.0.1:3180}"
CLAIM_HOST="${DSH_AGENTX_CLAIM_HOST:?Configure the explicit inference host to claim}"
NODE_BIN="${AGENTX_NODE_BIN:-/usr/local/bin/node}"
SKILL_ROOT="$INTEGRATION_ROOT"
PATCH="$SKILL_ROOT/guard.patch.yml"
TIMEOUT_SECONDS=1200
LOCK_WAIT_SECONDS=5
MODEL="${DSH_MODEL:?Configure the expected model from the external DSH settings}"

usage() {
  echo "usage: $(basename "$0") [--reuse] [--timeout-seconds 1..1200] <workspace-name> <task...>" >&2
}

reuse=0
while (( $# )); do
  case "$1" in
    --reuse) reuse=1; shift ;;
    --timeout-seconds)
      [[ $# -ge 2 ]] || { usage; exit 2; }
      TIMEOUT_SECONDS="$2"
      shift 2
      ;;
    --) shift; break ;;
    -*) usage; exit 2 ;;
    *) break ;;
  esac
done
if [[ ! "$TIMEOUT_SECONDS" =~ ^[0-9]+$ ]] || (( TIMEOUT_SECONDS < 1 || TIMEOUT_SECONDS > 1200 )); then
  echo "timeout must be between 1 and 1200 seconds" >&2
  exit 2
fi
if (( $# < 2 )); then
  usage
  exit 2
fi

workspace_name="$1"
shift
if [[ ! "$workspace_name" =~ ^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$ ]]; then
  echo "workspace name must match [A-Za-z0-9][A-Za-z0-9._-]{0,63}" >&2
  exit 2
fi
task="$*"
if [[ -z "${task//[[:space:]]/}" ]]; then
  echo "task must not be blank" >&2
  exit 2
fi

for required in /usr/bin/bwrap /usr/bin/flock /usr/bin/timeout /usr/bin/python3 /usr/bin/sha256sum /usr/bin/realpath "$NODE_BIN"; do
  [[ -x "$required" ]] || { echo "required runtime is unavailable: $required" >&2; exit 3; }
done
[[ -x "$DSH" ]] || { echo "dsh is not installed at $DSH" >&2; exit 3; }
[[ -r "$SETTINGS" ]] || { echo "dsh settings are unavailable at $SETTINGS" >&2; exit 3; }
[[ -r "$PATCH" ]] || { echo "managed DSH guard patch is unavailable at $PATCH" >&2; exit 3; }
[[ -r "$CLAIM_WRAPPER" ]] || { echo "AgentX claim wrapper is unavailable at $CLAIM_WRAPPER" >&2; exit 3; }

install -d -m 0700 -- "$BASE" "$STATE" "$RUNS" "$RECEIPTS" "$(dirname -- "$LOCK")"
exec 9>"$LOCK"
chmod 0600 "$LOCK"
if ! /usr/bin/flock -w "$LOCK_WAIT_SECONDS" 9; then
  echo "dsh lane is busy" >&2
  exit 75
fi

base_real="$(/usr/bin/realpath -e -- "$BASE")"
workspace="$BASE/$workspace_name"
if [[ -L "$workspace" ]]; then
  echo "workspace must not be a symbolic link" >&2
  exit 2
fi
if [[ -d "$workspace" ]]; then
  if (( reuse == 0 )) && [[ -n "$(find "$workspace" -mindepth 1 -maxdepth 1 -print -quit)" ]]; then
    echo "workspace already contains files; pass --reuse for an explicit follow-up" >&2
    exit 2
  fi
else
  install -d -m 0700 -- "$workspace"
fi
workspace_real="$(/usr/bin/realpath -e -- "$workspace")"
case "$workspace_real" in
  "$base_real"/*) ;;
  *) echo "workspace escaped the managed base" >&2; exit 2 ;;
esac
chmod 0700 "$workspace_real"

node_bin="$(/usr/bin/realpath -e -- "$NODE_BIN")"
node_root="$(cd -- "$(dirname -- "$node_bin")/.." && pwd -P)"
[[ -x "$node_root/bin/node" ]] || { echo "Node runtime root is invalid" >&2; exit 3; }

run_id="$(date -u +%Y%m%dT%H%M%SZ)-$$"
run_dir="$RUNS/$run_id"
private_home="$run_dir/home"
stdout_file="$run_dir/stdout"
stderr_file="$run_dir/stderr"
receipt="$RECEIPTS/$run_id.json"
receipt_tmp="$receipt.tmp"
claim_receipt="$RECEIPTS/$run_id.claim.json"
install -d -m 0700 -- "$private_home/.dsh"
install -m 0600 -- "$SETTINGS" "$private_home/.dsh/settings.yaml"
: >"$stdout_file"
: >"$stderr_file"

cleanup() {
  rm -rf -- "$run_dir"
}
trap cleanup EXIT

started_utc="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
started_ns="$(date +%s%N)"
dsh_version="$($DSH --version)"
task_sha256="$(printf '%s' "$task" | /usr/bin/sha256sum | awk '{print $1}')"

set +e
/usr/bin/timeout -k 30 "$TIMEOUT_SECONDS" \
  "$node_bin" "$CLAIM_WRAPPER" \
    --core "$CLAIM_CORE" \
    --host "$CLAIM_HOST" \
    --batch "dsh-headless-$run_id" \
    --owner dsh-headless \
    --note bounded-dsh-headless \
    --estimate-ms "$(( (TIMEOUT_SECONDS + 60) * 1000 ))" \
    --heartbeat-ttl-ms 60000 \
    --receipt "$claim_receipt" \
    -- \
  /usr/bin/bwrap \
    --unshare-all \
    --share-net \
    --die-with-parent \
    --new-session \
    --clearenv \
    --setenv HOME /home/agent \
    --setenv USER agent \
    --setenv LOGNAME agent \
    --setenv PATH /opt/node/bin:/usr/bin:/bin \
    --setenv LANG C.UTF-8 \
    --setenv DSH_HOME /home/agent/.dsh \
    --setenv DSH_PERMISSION_MODE workspace-write \
    --setenv DSH_TELEMETRY_MODE DISABLED \
    --setenv OLLAMA_AGENTX_API_KEY local-no-auth \
    --ro-bind /usr /usr \
    --ro-bind /lib /lib \
    --ro-bind /lib64 /lib64 \
    --symlink usr/bin /bin \
    --dir /etc \
    --ro-bind /etc/hosts /etc/hosts \
    --ro-bind /etc/resolv.conf /etc/resolv.conf \
    --ro-bind /etc/nsswitch.conf /etc/nsswitch.conf \
    --ro-bind /etc/ssl /etc/ssl \
    --proc /proc \
    --dev /dev \
    --tmpfs /tmp \
    --dir /home \
    --bind "$private_home" /home/agent \
    --ro-bind "$node_root" /opt/node \
    --ro-bind "$DSH_ROOT" /opt/dsh \
    --ro-bind "$SKILL_ROOT" /opt/skill \
    --bind "$workspace_real" /workspace \
    --chdir /workspace \
    /opt/dsh/node_modules/.bin/dsh --profile headless --patch /opt/skill/guard.patch.yml -- "$task" \
    >"$stdout_file" 2>"$stderr_file"
exit_code=$?
set -e

ended_ns="$(date +%s%N)"
ended_utc="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
duration_ms=$(( (ended_ns - started_ns) / 1000000 ))
stdout_sha256="$(/usr/bin/sha256sum "$stdout_file" | awk '{print $1}')"
stderr_sha256="$(/usr/bin/sha256sum "$stderr_file" | awk '{print $1}')"
stdout_bytes="$(stat -c %s "$stdout_file")"
stderr_bytes="$(stat -c %s "$stderr_file")"
claim_receipt_sha256=''
if [[ -f "$claim_receipt" ]]; then
  claim_receipt_sha256="$(/usr/bin/sha256sum "$claim_receipt" | awk '{print $1}')"
fi

/usr/bin/python3 - "$receipt_tmp" <<PY
import json
import pathlib
import sys

payload = {
    "schema": 1,
    "run_id": ${run_id@Q},
    "workspace_name": ${workspace_name@Q},
    "task_sha256": ${task_sha256@Q},
    "model": ${MODEL@Q},
    "dsh_version": ${dsh_version@Q},
    "started_at": ${started_utc@Q},
    "ended_at": ${ended_utc@Q},
    "duration_ms": int(${duration_ms@Q}),
    "timeout_seconds": int(${TIMEOUT_SECONDS@Q}),
    "exit_code": int(${exit_code@Q}),
    "timed_out": int(${exit_code@Q}) == 124,
    "stdout_sha256": ${stdout_sha256@Q},
    "stdout_bytes": int(${stdout_bytes@Q}),
    "stderr_sha256": ${stderr_sha256@Q},
    "stderr_bytes": int(${stderr_bytes@Q}),
    "claim": {
        "host": ${CLAIM_HOST@Q},
        "receipt": ${claim_receipt@Q},
        "receipt_sha256": ${claim_receipt_sha256@Q},
        "shared_lock": ${LOCK@Q},
    },
    "telemetry": "disabled",
    "sandbox": "bubblewrap-workspace-only",
    "fanout": "disabled",
}
path = pathlib.Path(sys.argv[1])
path.write_text(json.dumps(payload, sort_keys=True, separators=(",", ":")) + "\n", encoding="utf-8")
PY
chmod 0600 "$receipt_tmp"
mv -f -- "$receipt_tmp" "$receipt"
install -m 0600 -- "$receipt" "$RECEIPTS/latest.json"

cat "$stdout_file"
cat "$stderr_file" >&2
echo "dsh-receipt: $receipt" >&2
exit "$exit_code"
