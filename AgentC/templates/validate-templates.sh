#!/bin/bash
# Validate workflow templates
# Usage: ./validate-templates.sh

set -e

TEMPLATE_FILE="workflow-templates.json"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

cd "$SCRIPT_DIR"

echo "=========================================="
echo "SBQC Workflow Template Validator"
echo "=========================================="
echo ""

# Check if jq is installed
if ! command -v jq &> /dev/null; then
    echo "❌ Error: jq is not installed"
    echo "   Install with: sudo apt-get install jq"
    exit 1
fi

# Validate main JSON structure
echo "✓ Checking main JSON structure..."
if ! jq empty "$TEMPLATE_FILE" 2>/dev/null; then
    echo "❌ Invalid JSON in $TEMPLATE_FILE"
    exit 1
fi
echo "  ✓ Valid JSON"

# Check version
VERSION=$(jq -r '.version' "$TEMPLATE_FILE")
echo "  ✓ Version: $VERSION"

# Count templates
TEMPLATE_COUNT=$(jq '.templates | length' "$TEMPLATE_FILE")
echo "  ✓ Templates found: $TEMPLATE_COUNT"
echo ""

# Validate each template
echo "Validating individual templates..."
echo "=========================================="

TEMPLATES=$(jq -r '.templates | keys[]' "$TEMPLATE_FILE")
TOTAL=0
PASSED=0
FAILED=0

for template in $TEMPLATES; do
    TOTAL=$((TOTAL + 1))
    echo ""
    echo "Template: $template"
    echo "---"

    # Check name
    NAME=$(jq -r ".templates[\"$template\"].name" "$TEMPLATE_FILE")
    echo "  Name: $NAME"

    # Check workflow structure
    HAS_NODES=$(jq ".templates[\"$template\"].workflow.nodes | length" "$TEMPLATE_FILE")
    echo "  Nodes: $HAS_NODES"

    # Check connections
    HAS_CONNECTIONS=$(jq ".templates[\"$template\"].workflow.connections | length" "$TEMPLATE_FILE")
    echo "  Connection groups: $HAS_CONNECTIONS"

    # Validate workflow JSON
    WORKFLOW_JSON=$(jq ".templates[\"$template\"].workflow" "$TEMPLATE_FILE")
    if echo "$WORKFLOW_JSON" | jq empty 2>/dev/null; then
        echo "  ✓ Valid workflow structure"
        PASSED=$((PASSED + 1))
    else
        echo "  ❌ Invalid workflow structure"
        FAILED=$((FAILED + 1))
    fi

    # Check for required fields
    HAS_NAME=$(jq ".templates[\"$template\"].workflow.name" "$TEMPLATE_FILE")
    HAS_SETTINGS=$(jq ".templates[\"$template\"].workflow.settings" "$TEMPLATE_FILE")

    if [ "$HAS_NAME" != "null" ] && [ "$HAS_SETTINGS" != "null" ]; then
        echo "  ✓ Required fields present"
    else
        echo "  ⚠️  Missing some fields"
    fi

    # List node types
    NODE_TYPES=$(jq -r ".templates[\"$template\"].workflow.nodes[].type" "$TEMPLATE_FILE" | sort | uniq)
    echo "  Node types used:"
    echo "$NODE_TYPES" | sed 's/^/    - /'
done

echo ""
echo "=========================================="
echo "Summary"
echo "=========================================="
echo "Total templates: $TOTAL"
echo "Passed: $PASSED"
echo "Failed: $FAILED"
echo ""

if [ $FAILED -eq 0 ]; then
    echo "✓ All templates are valid!"
    exit 0
else
    echo "❌ Some templates have issues"
    exit 1
fi
