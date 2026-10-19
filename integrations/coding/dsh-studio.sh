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
integration_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
core_url="${AGENTX_CORE_URL:-http://127.0.0.1:3180}"
settings_helper="${integration_root}/dsh-studio-settings.cjs"
node_bin="${AGENTX_NODE_BIN:-/usr/local/bin/node}"
browser_bin="${DSH_STUDIO_BROWSER_EXECUTABLE:-}"
# Studio's own token for Core's OpenAI gateway (client `dsh-studio`).
gateway_token="${AGENTX_LLM_DSH_STUDIO_TOKEN:-}"
launch=()
if [[ -n "${DSH_STUDIO_LAUNCH_FILE:-}" ]]; then
  [[ "$DSH_STUDIO_LAUNCH_FILE" == /* ]] || fail 'Native launch file must be absolute'
  launch=("$node_bin" "$integration_root/dsh-studio-launch.cjs")
fi

[[ "$isolation" == 'bubblewrap' || "$isolation" == 'host' ]] || fail 'DSH_STUDIO_ISOLATION must be bubblewrap or host'
[[ "$port" =~ ^[0-9]+$ ]] && (( port >= 1024 && port <= 65535 )) || fail 'DSH_STUDIO_PORT must be between 1024 and 65535'
[[ "$trusted_host" =~ ^[A-Za-z0-9.:-]+$ ]] || fail 'DSH_STUDIO_TRUSTED_HOST is invalid'
[[ -x "$dsh_bin" ]] || fail "DSH is unavailable at ${dsh_bin}"
[[ -f "$settings" && ! -L "$settings" ]] || fail "DSH settings are unavailable or unsafe at ${settings}"
[[ "$workspace_root" == /* && "$state_root" == /* ]] || fail 'DSH Studio paths must be absolute'
[[ ! -L "$workspace_root" && ! -L "$state_root" ]] || fail 'DSH Studio roots must not be symbolic links'
[[ "$node_bin" == /* && -x "$node_bin" ]] || fail "Node runtime is unavailable at ${node_bin}"
[[ -r "$settings_helper" ]] || fail 'DSH Studio settings helper is unavailable'
[[ "$gateway_token" =~ ^[A-Za-z0-9._~+/=-]{16,}$ ]] || fail 'AGENTX_LLM_DSH_STUDIO_TOKEN is missing or invalid'
if [[ -n "$browser_bin" ]]; then
  [[ "$browser_bin" == /* && -x "$browser_bin" ]] || fail 'Chromium executable is unavailable'
  browser_bin="$(realpath -e -- "$browser_bin")"
fi

if [[ "${1:-}" == '--check' ]]; then
  [[ $# -eq 1 ]] || fail '--check accepts no additional arguments'
  [[ -d "$workspace_root" && -d "$state_root" ]] || fail 'DSH Studio roots are not installed'
  workspace_root="$(realpath -e -- "$workspace_root")"
  if [[ "$isolation" == 'bubblewrap' ]]; then
    [[ -x /usr/bin/bwrap ]] || fail 'Bubblewrap is unavailable'
  fi
  printf 'status=ready isolation=%s bind=127.0.0.1:%s workspace=%s admission=per-request\n' "$isolation" "$port" "$workspace_root"
  exit 0
fi
[[ $# -eq 0 ]] || fail 'DSH Studio accepts no command arguments'

install -d -m 0700 -- "$workspace_root" "$state_root"
workspace_root="$(realpath -e -- "$workspace_root")"
state_root="$(realpath -e -- "$state_root")"
studio_home="${state_root}/home"
install -d -m 0700 -- "$studio_home/.dsh"
# Let upstream import ordinary preferences once; only AgentX's routing stays in
# the managed overlay. Its imported marker prevents recreating legacy settings.
if [[ ! -e "$studio_home/.dsh/settings.yaml" && ! -e "$studio_home/.dsh/settings.yaml.imported" ]]; then
  install -m 0600 -- "$settings" "$studio_home/.dsh/settings.yaml"
fi
browser_mount=()
if [[ -n "$browser_bin" && "$isolation" == 'bubblewrap' ]]; then
  browser_mount=(--ro-bind "$(dirname -- "$browser_bin")" /opt/agentx-chromium)
  browser_bin="/opt/agentx-chromium/$(basename -- "$browser_bin")"
fi
DSH_STUDIO_BROWSER_EXECUTABLE="$browser_bin" "$node_bin" "$settings_helper" "$settings" "$studio_home/.dsh/agentx.patch.json" "$core_url"
api_key="$gateway_token"
unset AGENTX_LLM_DSH_STUDIO_TOKEN

export DSH_PERMISSION_MODE=workspace-write
export DSH_TELEMETRY_MODE=DISABLED
export PATH="$(dirname -- "$node_bin"):${dsh_root}/node_modules/.bin:${PATH}"

if [[ "$isolation" == 'host' ]]; then
  export AGENTX_CORE_API_KEY="$api_key"
  export DSH_HOME="${studio_home}/.dsh"
  cd -- "$workspace_root"
  exec "${launch[@]}" "$dsh_bin" web --patch "$DSH_HOME/agentx.patch.json" --host 127.0.0.1 --port "$port" --no-open --trusted-host "$trusted_host"
fi

[[ -x /usr/bin/bwrap ]] || fail 'Bubblewrap is unavailable'
node_bin="$(realpath -e -- "$node_bin")"
node_root="$(cd -- "$(dirname -- "$node_bin")/.." && pwd -P)"
private_home="$studio_home"
# The key reaches the sandbox through its private home, never a command line.
key_file="$studio_home/.dsh/agentx-core.key"
( umask 077; printf '%s' "$api_key" > "$key_file.tmp" && mv -f -- "$key_file.tmp" "$key_file" )

exec "${launch[@]}" /usr/bin/bwrap \
  --unshare-all \
  --share-net \
  --die-with-parent \
  --new-session \
  --clearenv \
  --setenv HOME /home/agent \
  --setenv USER agent \
  --setenv LOGNAME agent \
  --setenv PATH /opt/node/bin:/opt/dsh/node_modules/.bin:/usr/bin:/bin \
  --setenv LANG C.UTF-8 \
  --setenv DSH_HOME /home/agent/.dsh \
  --setenv DSH_PERMISSION_MODE workspace-write \
  --setenv DSH_TELEMETRY_MODE DISABLED \
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
  "${browser_mount[@]}" \
  --bind "$workspace_root" /workspaces \
  --chdir /workspaces \
  /usr/bin/bash -c 'export AGENTX_CORE_API_KEY="$(< /home/agent/.dsh/agentx-core.key)"; exec "$@"' dsh \
  /opt/dsh/node_modules/.bin/dsh web \
    --patch /home/agent/.dsh/agentx.patch.json \
    --host 127.0.0.1 \
    --port "$port" \
    --no-open \
    --trusted-host "$trusted_host"
