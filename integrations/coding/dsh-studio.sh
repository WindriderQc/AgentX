#!/usr/bin/env bash
# Start the human-operated DSH Web studio with an operator-selected boundary.
set -euo pipefail
umask 077

fail() { printf 'ERROR: %s\n' "$*" >&2; exit 1; }

isolation="${DSH_STUDIO_ISOLATION:-bubblewrap}"
port="${DSH_STUDIO_PORT:-3085}"
trusted_host="${DSH_STUDIO_TRUSTED_HOST:-127.0.0.1:${port}}"
dsh_root="${DSH_STUDIO_DSH_ROOT:-${HOME}/dsh}"
dsh_bin="${dsh_root}/node_modules/.bin/dsh"
settings="${DSH_STUDIO_SETTINGS_FILE:-${HOME}/.dsh/settings.yaml}"
workspace_root="${DSH_STUDIO_WORKSPACE_ROOT:-${HOME}/dsh-studio-workspaces}"
state_root="${DSH_STUDIO_STATE_ROOT:-${HOME}/.local/state/agentx/dsh-studio}"
lane_lock="${AGENTX_MODEL_LIFECYCLE_LOCK_FILE:-${HOME}/.local/state/agentx/model-lifecycle/local-inference.lock}"
integration_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
claim_wrapper="${AGENTX_CLAIM_WRAPPER:-${integration_root}/with-agentx-claim.js}"
claim_core="${AGENTX_CORE_URL:-http://127.0.0.1:3180}"
claim_host="${DSH_AGENTX_CLAIM_HOST:?Configure the explicit inference host to claim}"
claim_receipt="${DSH_STUDIO_CLAIM_RECEIPT:-${state_root}/claim-latest.json}"
node_bin="${AGENTX_NODE_BIN:-/usr/local/bin/node}"

[[ "$isolation" == 'bubblewrap' || "$isolation" == 'host' ]] || fail 'DSH_STUDIO_ISOLATION must be bubblewrap or host'
[[ "$port" =~ ^[0-9]+$ ]] && (( port >= 1024 && port <= 65535 )) || fail 'DSH_STUDIO_PORT must be between 1024 and 65535'
[[ "$trusted_host" =~ ^[A-Za-z0-9.:-]+$ ]] || fail 'DSH_STUDIO_TRUSTED_HOST is invalid'
[[ -x "$dsh_bin" ]] || fail "DSH is unavailable at ${dsh_bin}"
[[ -f "$settings" && ! -L "$settings" ]] || fail "DSH settings are unavailable or unsafe at ${settings}"
[[ "$workspace_root" == /* && "$state_root" == /* ]] || fail 'DSH Studio paths must be absolute'
[[ ! -L "$workspace_root" && ! -L "$state_root" ]] || fail 'DSH Studio roots must not be symbolic links'
[[ "$node_bin" == /* && -x "$node_bin" ]] || fail "Node runtime is unavailable at ${node_bin}"
[[ -x /usr/bin/flock ]] || fail 'flock is unavailable at /usr/bin/flock'
[[ -r "$claim_wrapper" ]] || fail "AgentX claim wrapper is unavailable at ${claim_wrapper}"

if [[ "${1:-}" == '--check' ]]; then
  [[ $# -eq 1 ]] || fail '--check accepts no additional arguments'
  [[ -d "$workspace_root" && -d "$state_root" ]] || fail 'DSH Studio roots are not installed'
  workspace_root="$(realpath -e -- "$workspace_root")"
  if [[ "$isolation" == 'bubblewrap' ]]; then
    [[ -x /usr/bin/bwrap ]] || fail 'Bubblewrap is unavailable'
  fi
  printf 'status=ready isolation=%s bind=127.0.0.1:%s workspace=%s claim=required\n' "$isolation" "$port" "$workspace_root"
  exit 0
fi
[[ $# -eq 0 ]] || fail 'DSH Studio accepts no command arguments'

install -d -m 0700 -- "$workspace_root" "$state_root" "$(dirname -- "$lane_lock")" "$(dirname -- "$claim_receipt")"
workspace_root="$(realpath -e -- "$workspace_root")"
state_root="$(realpath -e -- "$state_root")"
exec 9>"$lane_lock"
chmod 0600 "$lane_lock"
/usr/bin/flock -n 9 || { printf 'ERROR: shared model lifecycle lane is busy\n' >&2; exit 75; }
studio_home="${state_root}/home"
install -d -m 0700 -- "$studio_home/.dsh"
install -m 0600 -- "$settings" "$studio_home/.dsh/settings.yaml"

export DSH_PERMISSION_MODE=workspace-write
export DSH_TELEMETRY_MODE=DISABLED
export OLLAMA_AGENTX_API_KEY=local-no-auth
claim=(
  "$node_bin" "$claim_wrapper"
  --core "$claim_core"
  --host "$claim_host"
  --batch "dsh-studio-$(date -u +%Y%m%dT%H%M%SZ)-$$"
  --owner dsh-studio
  --note human-operated-dsh-studio
  --estimate-ms 86400000
  --heartbeat-ttl-ms 60000
  --receipt "$claim_receipt"
  --
)

if [[ "$isolation" == 'host' ]]; then
  export DSH_HOME="${studio_home}/.dsh"
  cd -- "$workspace_root"
  exec "${claim[@]}" "$dsh_bin" web --host 127.0.0.1 --port "$port" --no-open --trusted-host "$trusted_host"
fi

[[ -x /usr/bin/bwrap ]] || fail 'Bubblewrap is unavailable'
node_bin="$(realpath -e -- "$node_bin")"
node_root="$(cd -- "$(dirname -- "$node_bin")/.." && pwd -P)"
private_home="$studio_home"

exec "${claim[@]}" /usr/bin/bwrap \
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
  --ro-bind "$dsh_root" /opt/dsh \
  --bind "$workspace_root" /workspaces \
  --chdir /workspaces \
  /opt/dsh/node_modules/.bin/dsh web \
    --host 127.0.0.1 \
    --port "$port" \
    --no-open \
    --trusted-host "$trusted_host"
