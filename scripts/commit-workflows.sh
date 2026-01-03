#!/bin/bash
#
# commit-workflows.sh
# Automated workflow versioning script for Track 6
# Commits and pushes workflow changes from AgentX/AgentC to Git
#
# Usage: ./scripts/commit-workflows.sh
# Safe for cron: exits 0 if no changes, no interactive prompts

set -euo pipefail  # Exit on error/undefined vars; fail pipelines

# Optional lock to prevent overlapping cron runs
if [ "${1:-}" != "--no-lock" ] && command -v flock >/dev/null 2>&1; then
    LOCK_FILE="/tmp/agentx-commit-workflows.lock"
    exec flock -n "$LOCK_FILE" "$0" --no-lock
fi

# Resolve AgentX directory from this script location
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
AGENTX_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
AGENTC_PATH="AgentC"

TIMESTAMP=$(date +"%Y-%m-%d_%H:%M:%S")
COMMIT_MESSAGE="backup: automated workflow backup ${TIMESTAMP}"

# Logging function
log() {
    echo "[$(date +"%Y-%m-%d %H:%M:%S")] $*"
}

# Change to AgentX directory (main git repository)
if [ ! -d "$AGENTX_DIR" ]; then
    log "ERROR: AgentX directory not found: $AGENTX_DIR"
    exit 1
fi

cd "$AGENTX_DIR" || exit 1
log "Working directory: $(pwd)"

# Verify AgentC subdirectory exists
if [ ! -d "$AGENTC_PATH" ]; then
    log "ERROR: AgentC subdirectory not found: $AGENTC_PATH"
    exit 1
fi

# Configure git for non-interactive operation
export GIT_PAGER=cat
export GIT_TERMINAL_PROMPT=0
git config --local core.pager cat 2>/dev/null || true

# Check if this is a git repository
if [ ! -d ".git" ]; then
    log "ERROR: Not a git repository: $AGENTX_DIR"
    exit 1
fi

# Check for changes in AgentC directory (tracked or untracked)
if git diff --quiet -- "$AGENTC_PATH" && git diff --cached --quiet -- "$AGENTC_PATH"; then
    UNTRACKED_WORKFLOWS=$(git ls-files --others --exclude-standard "$AGENTC_PATH" 2>/dev/null | wc -l | tr -d ' ')
    if [ "${UNTRACKED_WORKFLOWS:-0}" -eq 0 ]; then
        log "No changes detected in $AGENTC_PATH. Skipping commit."
        exit 0
    fi
    log "Found ${UNTRACKED_WORKFLOWS} untracked file(s) in $AGENTC_PATH"
else
    log "Changes detected in $AGENTC_PATH"
fi

# Stage workflow artifacts (including modified/new/deleted)
git add "$AGENTC_PATH"/*.json 2>/dev/null || true
git add "$AGENTC_PATH"/test-payloads/*.json 2>/dev/null || true
git add "$AGENTC_PATH"/*.md 2>/dev/null || true

# Double-check if we now have staged changes
if git diff --cached --quiet -- "$AGENTC_PATH"; then
    log "No staged changes in $AGENTC_PATH after git add. Nothing to commit."
    exit 0
fi

# Show what we're committing (for log visibility)
log "Files to commit:"
git diff --cached --name-only -- "$AGENTC_PATH" | sed 's/^/  /'

# Commit changes
log "Committing changes: $COMMIT_MESSAGE"
git -c commit.gpgsign=false commit -m "$COMMIT_MESSAGE" --no-verify --quiet

# Push to remote (if configured)
if git remote get-url origin >/dev/null 2>&1; then
    BRANCH=$(git rev-parse --abbrev-ref HEAD)
    log "Pushing to remote repository (origin/${BRANCH})..."
    if git push origin "$BRANCH" --quiet 2>&1; then
        log "✅ Successfully pushed workflow backup to remote"
    else
        log "❌ Push failed (network issue or remote unavailable). Commit saved locally."
        exit 1
    fi
else
    log "❌ No 'origin' remote configured. Commit saved locally only."
    exit 1
fi

log "Workflow backup completed successfully"
exit 0
