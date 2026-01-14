#!/bin/bash
# Archive all markdown files from AgentX with folder hierarchy
# Maintains directory structure for easy restoration and RAG updates

set -euo pipefail

# Configuration
PROJECT_ROOT="/home/user/AgentX"
TIMESTAMP=$(date +%Y%m%d_%H%M%S)
ARCHIVE_DIR="${BACKUP_DIR:-/mnt/datalake/backups}/md-archives"
ARCHIVE_NAME="agentx-markdown-${TIMESTAMP}.tar.gz"
ARCHIVE_PATH="${ARCHIVE_DIR}/${ARCHIVE_NAME}"

# Colors for output
GREEN='\033[0;32m'
BLUE='\033[0;34m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

echo -e "${BLUE}===================================${NC}"
echo -e "${BLUE}AgentX Markdown Archive Tool${NC}"
echo -e "${BLUE}===================================${NC}"

# Create archive directory if it doesn't exist
mkdir -p "${ARCHIVE_DIR}"

# Change to project root
cd "${PROJECT_ROOT}"

echo -e "${YELLOW}Searching for markdown files...${NC}"

# Find all .md files, excluding node_modules, .git, and coverage
TEMP_FILE_LIST=$(mktemp)
find . \
  -type f \
  -name "*.md" \
  -not -path "*/node_modules/*" \
  -not -path "*/.git/*" \
  -not -path "*/coverage/*" \
  -not -path "*/dist/*" \
  -not -path "*/build/*" \
  > "${TEMP_FILE_LIST}"

FILE_COUNT=$(wc -l < "${TEMP_FILE_LIST}")

echo -e "${GREEN}Found ${FILE_COUNT} markdown files${NC}"

if [ "${FILE_COUNT}" -eq 0 ]; then
  echo "No markdown files found. Exiting."
  rm "${TEMP_FILE_LIST}"
  exit 0
fi

# Display some statistics
echo -e "${YELLOW}Directory breakdown:${NC}"
cat "${TEMP_FILE_LIST}" | xargs -I{} dirname {} | sort | uniq -c | sort -rn | head -10

echo -e "${YELLOW}Creating archive: ${ARCHIVE_PATH}${NC}"

# Create tar.gz archive with folder hierarchy preserved
tar -czf "${ARCHIVE_PATH}" \
  --files-from="${TEMP_FILE_LIST}" \
  --transform 's,^\./,,' \
  2>/dev/null

# Clean up temp file
rm "${TEMP_FILE_LIST}"

# Get archive size
ARCHIVE_SIZE=$(du -h "${ARCHIVE_PATH}" | cut -f1)

echo -e "${GREEN}===================================${NC}"
echo -e "${GREEN}Archive created successfully!${NC}"
echo -e "${GREEN}===================================${NC}"
echo -e "Location: ${ARCHIVE_PATH}"
echo -e "Size: ${ARCHIVE_SIZE}"
echo -e "Files: ${FILE_COUNT}"

# Create a manifest file listing all archived files
MANIFEST_PATH="${ARCHIVE_DIR}/agentx-markdown-${TIMESTAMP}.manifest.txt"
echo "# AgentX Markdown Archive Manifest" > "${MANIFEST_PATH}"
echo "# Created: $(date)" >> "${MANIFEST_PATH}"
echo "# Archive: ${ARCHIVE_NAME}" >> "${MANIFEST_PATH}"
echo "# File count: ${FILE_COUNT}" >> "${MANIFEST_PATH}"
echo "" >> "${MANIFEST_PATH}"
tar -tzf "${ARCHIVE_PATH}" | sort >> "${MANIFEST_PATH}"

echo -e "Manifest: ${MANIFEST_PATH}"

# Optional: Create symlink to latest
ln -sf "${ARCHIVE_NAME}" "${ARCHIVE_DIR}/latest.tar.gz"
ln -sf "$(basename ${MANIFEST_PATH})" "${ARCHIVE_DIR}/latest.manifest.txt"

echo -e "${BLUE}Symlinks updated: latest.tar.gz -> ${ARCHIVE_NAME}${NC}"

# Cleanup old archives (keep last 10)
echo -e "${YELLOW}Cleaning up old archives (keeping last 10)...${NC}"
cd "${ARCHIVE_DIR}"
ls -t agentx-markdown-*.tar.gz 2>/dev/null | tail -n +11 | xargs -r rm -f
ls -t agentx-markdown-*.manifest.txt 2>/dev/null | tail -n +11 | xargs -r rm -f

REMAINING=$(ls -1 agentx-markdown-*.tar.gz 2>/dev/null | wc -l)
echo -e "${GREEN}Archive complete. ${REMAINING} archives retained.${NC}"

# Output JSON for n8n integration
cat <<EOF

{
  "status": "success",
  "archive": {
    "path": "${ARCHIVE_PATH}",
    "name": "${ARCHIVE_NAME}",
    "size": "${ARCHIVE_SIZE}",
    "fileCount": ${FILE_COUNT},
    "manifest": "${MANIFEST_PATH}",
    "timestamp": "${TIMESTAMP}"
  }
}
EOF
