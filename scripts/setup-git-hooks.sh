#!/bin/bash
# Setup git hooks for AgentX project

set -e

REPO_ROOT=$(git rev-parse --show-toplevel)
HOOKS_DIR="$REPO_ROOT/.git/hooks"

echo "Setting up git hooks for AgentX..."

# Pre-commit hook
cat > "$HOOKS_DIR/pre-commit" << 'EOF'
#!/bin/sh
# AgentX pre-commit hook - runs tests before allowing commit

echo "🔍 Running pre-commit checks..."

# Run tests
echo "Running tests (npm test)..."
npm test

if [ $? -ne 0 ]; then
  echo "❌ Tests failed. Commit aborted."
  echo "Fix failing tests or use 'git commit --no-verify' to skip (not recommended)."
  exit 1
fi

echo "✅ All checks passed!"
exit 0
EOF

# Make hooks executable
chmod +x "$HOOKS_DIR/pre-commit"

echo "✅ Git hooks installed successfully!"
echo ""
echo "Installed hooks:"
echo "  - pre-commit: Runs 'npm test' before each commit"
echo ""
echo "To skip hooks temporarily (not recommended):"
echo "  git commit --no-verify"
