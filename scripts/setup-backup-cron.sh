#!/bin/bash
# Setup automated backups via cron (AgentX)

CRON_FILE="/tmp/agentx-backup-cron"

# Keep paths/env in sync with AgentX dashboard defaults.
# - AgentX API defaults BACKUP_DIR to /mnt/datalake/backups
# - Backup scripts accept an explicit target dir argument
DEFAULT_BACKUP_ROOT="/mnt/datalake/backups"
LOG_FILE="/home/yb/agentx-backup.log"

cat > "$CRON_FILE" <<EOF
# AgentX Automated Backups

# MongoDB backup - Daily at 2 AM
0 2 * * * cd /home/yb/codes/AgentX && /home/yb/codes/AgentX/scripts/backup-mongodb.sh "${BACKUP_DIR:-$DEFAULT_BACKUP_ROOT}/mongodb" >> "$LOG_FILE" 2>&1

# Qdrant backup - Daily at 3 AM
0 3 * * * cd /home/yb/codes/AgentX && /home/yb/codes/AgentX/scripts/backup-qdrant.sh "${BACKUP_DIR:-$DEFAULT_BACKUP_ROOT}/qdrant" >> "$LOG_FILE" 2>&1

# Workflow git commit - Every 6 hours
0 */6 * * * cd /home/yb/codes/AgentX && ./scripts/commit-workflows.sh >> "$LOG_FILE" 2>&1
EOF

crontab "$CRON_FILE"
rm "$CRON_FILE"

echo "✅ Backup cron jobs installed"
echo "View with: crontab -l"
