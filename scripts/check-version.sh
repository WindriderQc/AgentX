#!/bin/bash

# Check if package.json version matches CHANGELOG.md latest version
# Usage: ./check-version.sh [path/to/repo]

REPO_PATH="${1:-.}"
PKG_JSON="$REPO_PATH/package.json"

# Determine CHANGELOG path
# Prefer docs/project/CHANGELOG.md if it exists, as it's the new standard
if [ -f "$REPO_PATH/docs/project/CHANGELOG.md" ]; then
    CHANGELOG="$REPO_PATH/docs/project/CHANGELOG.md"
elif [ -f "$REPO_PATH/CHANGELOG.md" ]; then
    CHANGELOG="$REPO_PATH/CHANGELOG.md"
else
    echo "❌ Error: CHANGELOG.md not found in $REPO_PATH or $REPO_PATH/docs/project/"
    exit 1
fi

echo "Using changelog: $CHANGELOG"

if [ ! -f "$PKG_JSON" ]; then
    echo "❌ Error: package.json not found in $REPO_PATH"
    exit 1
fi

# Extract version from package.json
PKG_VERSION=$(grep '"version":' "$PKG_JSON" | head -n 1 | sed -E 's/.*"version": "([^"]+)".*/\1/')

# Extract latest version from CHANGELOG.md (looks for ## [X.Y.Z])
# We skip [Unreleased] and find the first version number
RAW_CHANGELOG_LINE=$(grep -E '^## \[[0-9]+\.[0-9]+\.[0-9]+\]' "$CHANGELOG" | head -n 1)
CHANGELOG_VERSION=$(echo "$RAW_CHANGELOG_LINE" | sed -E 's/^## \[([0-9]+\.[0-9]+\.[0-9]+)\].*/\1/' | tr -d '[:space:]')
PKG_VERSION=$(echo "$PKG_VERSION" | tr -d '[:space:]')

echo "Checking version consistency for $REPO_PATH..."
echo "  package.json: $PKG_VERSION"
echo "  CHANGELOG.md: $CHANGELOG_VERSION (from line: $RAW_CHANGELOG_LINE)"

if [ "$PKG_VERSION" == "$CHANGELOG_VERSION" ]; then
    echo "✅ Success: Versions match."
    exit 0
else
    echo "❌ Failure: Version mismatch!"
    echo "  Please update package.json or CHANGELOG.md to match."
    exit 1
fi
