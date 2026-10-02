#!/usr/bin/env bash
# Prepare a disposable Debian 12 development VM for AgentX coding agents.
# Safe to re-run: every step checks what is already installed.
#
# Usage:  bash scripts/devbox/bootstrap.sh
#   NODE_MAJOR=26            Node.js major version (keep it equal to production)
#   AGENTS="opencode claude codex"   coding agents to install (any subset, or "")
#   REPO_URL=...             AgentX clone source
#   CHECKOUT=~/codes/AgentX  clone location
#
# Credentials (gh, agents, provider keys) are never handled here; log in manually.
set -euo pipefail

NODE_MAJOR="${NODE_MAJOR:-26}"
AGENTS="${AGENTS-opencode claude codex}"
REPO_URL="${REPO_URL:-https://github.com/WindriderQc/AgentX.git}"
CHECKOUT="${CHECKOUT:-$HOME/codes/AgentX}"
NPM_PREFIX="$HOME/.local"

step() { printf '\n== %s\n' "$*"; }
have() { command -v "$1" >/dev/null 2>&1; }
apt_get() { sudo DEBIAN_FRONTEND=noninteractive apt-get "$@"; }

if [ "$(id -u)" -eq 0 ]; then
  echo "Run as your normal user (sudo is used where needed)." >&2
  exit 1
fi
. /etc/os-release
if [ "${ID:-}" != "debian" ]; then
  echo "Expected Debian, found ${PRETTY_NAME:-unknown}." >&2
  exit 1
fi

step "Base packages"
apt_get update -qq
apt_get install -y -qq ca-certificates curl gnupg git jq ripgrep \
  build-essential python3 python3-venv unzip tmux >/dev/null

sudo install -m 0755 -d /etc/apt/keyrings

step "Docker (official repository)"
if ! have docker; then
  curl -fsSL https://download.docker.com/linux/debian/gpg \
    | sudo gpg --dearmor --yes -o /etc/apt/keyrings/docker.gpg
  echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/debian ${VERSION_CODENAME} stable" \
    | sudo tee /etc/apt/sources.list.d/docker.list >/dev/null
  apt_get update -qq
  apt_get install -y -qq docker-ce docker-ce-cli containerd.io \
    docker-buildx-plugin docker-compose-plugin >/dev/null
fi
if ! id -nG "$USER" | grep -qw docker; then
  sudo usermod -aG docker "$USER"
  echo "Added $USER to the docker group; log out and back in to use it."
fi

step "Node.js ${NODE_MAJOR}"
if ! have node || [ "$(node -p 'process.versions.node.split(".")[0]')" != "$NODE_MAJOR" ]; then
  curl -fsSL "https://deb.nodesource.com/setup_${NODE_MAJOR}.x" | sudo -E bash - >/dev/null 2>&1
  apt_get install -y -qq nodejs >/dev/null
fi

step "GitHub CLI"
if ! have gh; then
  curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
    | sudo tee /etc/apt/keyrings/githubcli-archive-keyring.gpg >/dev/null
  echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
    | sudo tee /etc/apt/sources.list.d/github-cli.list >/dev/null
  apt_get update -qq
  apt_get install -y -qq gh >/dev/null
fi

step "Coding agents: ${AGENTS:-none}"
# Global npm packages go to ~/.local so agents can update themselves without sudo.
npm config set prefix "$NPM_PREFIX"
case ":$PATH:" in *":$NPM_PREFIX/bin:"*) ;; *)
  echo "export PATH=\"$NPM_PREFIX/bin:\$PATH\"" >> "$HOME/.bashrc"
  export PATH="$NPM_PREFIX/bin:$PATH" ;;
esac
for agent in $AGENTS; do
  case "$agent" in
    opencode) pkg=opencode-ai ;;
    claude)   pkg=@anthropic-ai/claude-code ;;
    codex)    pkg=@openai/codex ;;
    *) echo "Unknown agent: $agent" >&2; exit 1 ;;
  esac
  have "$agent" || npm install -g --silent "$pkg"
done

step "AgentX checkout"
if [ -d "$CHECKOUT/.git" ]; then
  echo "Already cloned at $CHECKOUT"
elif gh auth status >/dev/null 2>&1; then
  mkdir -p "$(dirname "$CHECKOUT")"
  gh repo clone "$REPO_URL" "$CHECKOUT"
  (cd "$CHECKOUT" && npm run setup)
else
  echo "Skipped: run 'gh auth login', then re-run this script."
fi

step "Done"
cat <<EOF
Manual, once per VM (credentials stay in the VM, never in Git):
  gh auth login && gh auth setup-git
  git config --global user.name "..." && git config --global user.email "..."
  log in to each agent you use (opencode auth login, claude, codex)
Then take a Hyper-V checkpoint of this clean state.
EOF
