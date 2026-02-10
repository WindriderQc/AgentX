#!/usr/bin/env bash
# Run full markdown archive + RAG ingestion in one canonical command.
# Intended for cron and n8n Execute Command nodes.
# Usage: ./scripts/archive-and-ingest-all.sh [--dry-run] [--docs-only] [--json]

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

DRY_RUN=false
DOCS_ONLY=false
JSON_OUTPUT=false

for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN=true ;;
    --docs-only) DOCS_ONLY=true ;;
    --json) JSON_OUTPUT=true ;;
    *)
      echo "Unknown argument: $arg" >&2
      echo "Usage: ./scripts/archive-and-ingest-all.sh [--dry-run] [--docs-only] [--json]" >&2
      exit 2
      ;;
  esac
done

started_at="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
mode="full"
if [ "$DOCS_ONLY" = true ]; then
  mode="docs"
fi

cd "$PROJECT_ROOT"

# Prefer existing BACKUP_DIR, otherwise fall back to a writable location.
if [ -z "${BACKUP_DIR:-}" ]; then
  if [ -d "/mnt/datalake/backups" ] || [ -w "/mnt/datalake" ]; then
    BACKUP_DIR="/mnt/datalake/backups"
  else
    BACKUP_DIR="${HOME}/backups"
  fi
fi
export BACKUP_DIR

STATUS_FILE="${RAG_CODEBASE_SYNC_STATUS_FILE:-${PROJECT_ROOT}/logs/rag-codebase-sync.status.json}"
LOG_FILE="${RAG_CODEBASE_SYNC_LOG_FILE:-${PROJECT_ROOT}/logs/rag-codebase-sync.log}"
TRIGGER_SOURCE="${RAG_CODEBASE_SYNC_TRIGGER:-script}"

mkdir -p "$(dirname "$STATUS_FILE")"
mkdir -p "$(dirname "$LOG_FILE")"

write_status() {
  local payload="$1"
  printf '%s\n' "$payload" > "$STATUS_FILE"
}

append_log() {
  local line="$1"
  printf '%s\n' "$line" >> "$LOG_FILE"
}

archive_json=""
ingest_json=""

running_json="{\"status\":\"running\",\"startedAt\":\"$started_at\",\"mode\":\"$mode\",\"dryRun\":$DRY_RUN,\"docsOnly\":$DOCS_ONLY,\"trigger\":\"$TRIGGER_SOURCE\",\"pid\":$$}"
write_status "$running_json"
append_log "$running_json"

on_error() {
  local exit_code=$?
  local finished_at
  finished_at="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

  local error_json
  error_json="{\"status\":\"error\",\"startedAt\":\"$started_at\",\"finishedAt\":\"$finished_at\",\"mode\":\"$mode\",\"dryRun\":$DRY_RUN,\"docsOnly\":$DOCS_ONLY,\"trigger\":\"$TRIGGER_SOURCE\",\"message\":\"archive or ingest step failed\",\"exitCode\":$exit_code"
  if [ -n "$archive_json" ]; then
    error_json="$error_json,\"archive\":$archive_json"
  fi
  if [ -n "$ingest_json" ]; then
    error_json="$error_json,\"ingest\":$ingest_json"
  fi
  error_json="$error_json}"

  write_status "$error_json"
  append_log "$error_json"

  if [ "$JSON_OUTPUT" = true ]; then
    echo "$error_json"
  else
    echo "ERROR: Archive + ingest failed (exit code: $exit_code)"
    echo "[agentx-rag-sync] Status: $STATUS_FILE"
    echo "[agentx-rag-sync] Log: $LOG_FILE"
  fi
  exit "$exit_code"
}

trap on_error ERR

ingest_args=(scripts/ingest-docs.js)
if [ "$DOCS_ONLY" = false ]; then
  ingest_args+=(--full)
fi
if [ "$DRY_RUN" = true ]; then
  ingest_args+=(--dry-run)
fi

archive_json="$(./scripts/archive-md-files.sh --json)"
ingest_json="$(node "${ingest_args[@]}" --json)"
finished_at="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

result_json="{\"status\":\"success\",\"startedAt\":\"$started_at\",\"finishedAt\":\"$finished_at\",\"mode\":\"$mode\",\"dryRun\":$DRY_RUN,\"docsOnly\":$DOCS_ONLY,\"trigger\":\"$TRIGGER_SOURCE\",\"archive\":$archive_json,\"ingest\":$ingest_json}"
write_status "$result_json"
append_log "$result_json"

if [ "$JSON_OUTPUT" = true ]; then
  echo "$result_json"
else
  archived_count="$(printf '%s' "$archive_json" | sed -n 's/.*"files":\([0-9][0-9]*\).*/\1/p')"
  ingested_count="$(printf '%s' "$ingest_json" | sed -n 's/.*"ingested":\([0-9][0-9]*\).*/\1/p')"
  failed_count="$(printf '%s' "$ingest_json" | sed -n 's/.*"failed":\([0-9][0-9]*\).*/\1/p')"
  echo "[agentx-rag-sync] Completed at $finished_at"
  echo "[agentx-rag-sync] Mode: $mode (dryRun=$DRY_RUN)"
  echo "[agentx-rag-sync] Archived: ${archived_count:-0} file(s), Ingested: ${ingested_count:-0}, Failed: ${failed_count:-0}"
  echo "[agentx-rag-sync] Status: $STATUS_FILE"
  echo "[agentx-rag-sync] Log: $LOG_FILE"
fi
