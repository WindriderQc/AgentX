#!/bin/bash
set -e

# MongoDB Restore Script for AgentX
# Usage: ./scripts/restore-mongodb.sh <backup_file.tar.gz>

if [ -z "$1" ]; then
  echo "Usage: ./scripts/restore-mongodb.sh <backup_file.tar.gz>"
  echo ""
  echo "Available backups:"
  find /mnt/datalake/backups/mongodb -name "agentx_*.tar.gz" -printf "%T@ %p\n" | sort -rn | cut -d' ' -f2- | head -10
  exit 1
fi

BACKUP_FILE="$1"
TEMP_DIR="/tmp/mongodb_restore_$(date +%s)"

# Load environment
if [ -f .env ]; then
  export $(cat .env | grep -v '^#' | xargs)
fi

if [ -z "$MONGODB_URI" ]; then
  echo "❌ Error: MONGODB_URI not set"
  exit 1
fi

# Confirm restore (destructive operation!)
echo "⚠️  WARNING: This will DROP existing database and restore from backup"
echo "Backup file: $BACKUP_FILE"
echo ""
read -p "Type 'yes' to proceed: " CONFIRM

if [ "$CONFIRM" != "yes" ]; then
  echo "Restore cancelled"
  exit 0
fi

echo "🔄 Starting MongoDB restore..."

# Extract backup
mkdir -p "$TEMP_DIR"
echo "Extracting backup..."
tar -xzf "$BACKUP_FILE" -C "$TEMP_DIR"

# Find the extracted directory
BACKUP_DIR=$(find "$TEMP_DIR" -maxdepth 1 -type d -name "agentx_*" | head -1)

if [ -z "$BACKUP_DIR" ]; then
  echo "❌ Error: Could not find extracted backup directory"
  rm -rf "$TEMP_DIR"
  exit 1
fi

# Run mongorestore
echo "Restoring database..."
mongorestore --uri="$MONGODB_URI" --drop "$BACKUP_DIR/"

if [ $? -eq 0 ]; then
  echo "✅ MongoDB restore completed successfully"
else
  echo "❌ Restore failed!"
  exit 1
fi

# Cleanup
rm -rf "$TEMP_DIR"

echo ""
echo "✓ Restore complete. Verify with: mongosh \"$MONGODB_URI\" --eval 'db.stats()'"
