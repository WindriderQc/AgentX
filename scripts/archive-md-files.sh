#!/usr/bin/env bash
# Archive all markdown files from AgentX codebase preserving folder hierarchy.
# Output: /mnt/datalake/backups/md-archives/agentx-md-YYYYMMDD-HHMMSS.tar.gz
# Usage: ./scripts/archive-md-files.sh [--json] [--output-dir /custom/path]

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
OUTPUT_DIR="${BACKUP_DIR:-/mnt/datalake/backups}/md-archives"
JSON_OUTPUT=false
MAX_ARCHIVES=10

# Parse args
for arg in "$@"; do
  case "$arg" in
    --json) JSON_OUTPUT=true ;;
    --output-dir=*) OUTPUT_DIR="${arg#*=}" ;;
  esac
done

TIMESTAMP=$(date +%Y%m%d-%H%M%S)
ARCHIVE_NAME="agentx-md-${TIMESTAMP}.tar.gz"
MANIFEST_NAME="agentx-md-${TIMESTAMP}.manifest"

mkdir -p "$OUTPUT_DIR"

# Build file list (exclude noise directories)
cd "$PROJECT_ROOT"
FILE_LIST=$(find . -name "*.md" \
  -not -path "./node_modules/*" \
  -not -path "./.git/*" \
  -not -path "./coverage/*" \
  -not -path "./playwright-report/*" \
  -not -path "./test-results/*" \
  -not -path "./.backups/*" \
  | sort)

FILE_COUNT=$(echo "$FILE_LIST" | wc -l)

# Create archive
echo "$FILE_LIST" | tar -czf "$OUTPUT_DIR/$ARCHIVE_NAME" -T -
echo "$FILE_LIST" > "$OUTPUT_DIR/$MANIFEST_NAME"

# Symlink latest
ln -sf "$ARCHIVE_NAME" "$OUTPUT_DIR/latest.tar.gz"
ln -sf "$MANIFEST_NAME" "$OUTPUT_DIR/latest.manifest"

ARCHIVE_SIZE=$(du -h "$OUTPUT_DIR/$ARCHIVE_NAME" | cut -f1)

# Cleanup old archives (keep last MAX_ARCHIVES)
ls -1t "$OUTPUT_DIR"/agentx-md-*.tar.gz 2>/dev/null | tail -n +$((MAX_ARCHIVES + 1)) | xargs -r rm -f
ls -1t "$OUTPUT_DIR"/agentx-md-*.manifest 2>/dev/null | tail -n +$((MAX_ARCHIVES + 1)) | xargs -r rm -f

if [ "$JSON_OUTPUT" = true ]; then
  echo "{\"status\":\"success\",\"archive\":\"$OUTPUT_DIR/$ARCHIVE_NAME\",\"files\":$FILE_COUNT,\"size\":\"$ARCHIVE_SIZE\",\"timestamp\":\"$TIMESTAMP\"}"
else
  echo "✅ Archived $FILE_COUNT markdown files ($ARCHIVE_SIZE)"
  echo "   Archive: $OUTPUT_DIR/$ARCHIVE_NAME"
  echo "   Manifest: $OUTPUT_DIR/$MANIFEST_NAME"
fi
