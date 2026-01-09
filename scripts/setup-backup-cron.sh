#!/bin/bash
# Setup automated backups via cron (AgentX)

CRON_FILE="/tmp/agentx-backup-cron"

# Use home directory for backups (more reliable than /mnt)
DEFAULT_BACKUP_ROOT="$HOME/backups"
LOG_FILE="$HOME/agentx-backup.log"

# Ensure backup directories exist
mkdir -p "${BACKUP_DIR:-$DEFAULT_BACKUP_ROOT}/mongodb"
mkdir -p "${BACKUP_DIR:-$DEFAULT_BACKUP_ROOT}/qdrant"

# Ensure log file exists and is writable
touch "$LOG_FILE" 2>/dev/null || LOG_FILE="/tmp/agentx-backup.log"

cat > "$CRON_FILE" <<EOF
# AgentX Automated Backups

# MongoDB backup - Daily at 2 AM
0 2 * * * cd $HOME/codes/AgentX && $HOME/codes/AgentX/scripts/backup-mongodb.sh "${BACKUP_DIR:-$DEFAULT_BACKUP_ROOT}/mongodb" >> "$LOG_FILE" 2>&1

# Qdrant backup - Daily at 3 AM
0 3 * * * cd $HOME/codes/AgentX && $HOME/codes/AgentX/scripts/backup-qdrant.sh "${BACKUP_DIR:-$DEFAULT_BACKUP_ROOT}/qdrant" >> "$LOG_FILE" 2>&1

# Workflow git commit - Every 6 hours
0 */6 * * * cd $HOME/codes/AgentX && ./scripts/commit-workflows.sh >> "$LOG_FILE" 2>&1
EOF

crontab "$CRON_FILE"
rm "$CRON_FILE"

echo "✅ Backup cron jobs installed"
echo "View with: crontab -l"
echo "Logs: $LOG_FILE"
