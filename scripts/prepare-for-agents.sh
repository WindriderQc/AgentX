#!/bin/bash
# Prepare repository for multi-agent development
set -e

echo "🚀 Preparing AgentX for multi-agent development..."

# 1. Create feature branches for each track
echo ""
echo "📋 Creating feature branches..."
TRACKS=(
  "feature/track-1-alerts"
  "feature/track-2-metrics"
  "feature/track-3-custom-models"
  "feature/track-4-self-healing"
  "feature/track-5-testing-cicd"
  "feature/track-6-backup"
)

for branch in "${TRACKS[@]}"; do
  if git rev-parse --verify "$branch" >/dev/null 2>&1; then
    echo "  ✓ Branch $branch already exists"
  else
    git branch "$branch"
    echo "  ✓ Created branch $branch"
  fi
done

# 2. Create directory structure for new files
echo ""
echo "📁 Creating directory structure..."
mkdir -p config/schemas
mkdir -p tests/workflows
mkdir -p tests/load
mkdir -p public/css/components
mkdir -p public/js/components
mkdir -p scripts/backup
mkdir -p docs/api
mkdir -p .github/workflows

echo "  ✓ Directories created"

# 3. Verify environment setup
echo ""
echo "🔍 Checking environment..."
if [ ! -f .env ]; then
  echo "  ⚠️  No .env file found. Copy from .env.example:"
  echo "     cp .env.example .env"
else
  echo "  ✓ .env file exists"
fi

# 4. Check dependencies
echo ""
echo "📦 Checking dependencies..."
if [ -f package.json ]; then
  echo "  ✓ package.json found"

  # Check if node_modules exists
  if [ ! -d node_modules ]; then
    echo "  ⚠️  node_modules not found. Run: npm install"
  else
    echo "  ✓ node_modules exists"
  fi
else
  echo "  ❌ package.json not found!"
  exit 1
fi

# 5. Check database connection
echo ""
echo "🗄️  Checking MongoDB..."
if [ -n "$MONGODB_URI" ]; then
  echo "  ✓ MONGODB_URI is set"
else
  echo "  ⚠️  MONGODB_URI not set in environment"
fi

# 6. Create .gitignore additions if needed
echo ""
echo "📝 Updating .gitignore..."
GITIGNORE_ADDITIONS=(
  "# Agent work artifacts"
  "docs/planning/AGENT_TRACKING.md"
  "*.agent.log"
  ".agent-workspace/"
  ""
  "# Backup files"
  "/mnt/backups/"
  "*.backup"
  "*.snapshot"
)

for line in "${GITIGNORE_ADDITIONS[@]}"; do
  if ! grep -qF "$line" .gitignore 2>/dev/null; then
    echo "$line" >> .gitignore
  fi
done
echo "  ✓ .gitignore updated"

# 7. Summary
echo ""
echo "✅ Preparation complete!"
echo ""
echo "📋 Next steps:"
echo "1. Review docs/planning/MULTI_AGENT_ENHANCEMENT_PLAN.md"
echo "2. Choose execution model (A/B/C)"
echo "3. Assign tasks to agents"
echo "4. Create feature branch: git checkout feature/track-X-name"
echo "5. Start implementing!"
echo ""
echo "🔗 Key files:"
echo "  - docs/planning/QUICK_START_GUIDE.md"
echo "  - docs/planning/AGENT_TRACKING.md"
echo ""
