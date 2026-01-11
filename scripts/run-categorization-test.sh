#!/bin/bash
# Categorization Test Script
# Runs diagnostic prompts to determine a model's recommended category
#
# Usage:
#   ./scripts/run-categorization-test.sh <model-name> [base-url] [host]
#
# Example:
#   ./scripts/run-categorization-test.sh qwen2.5-7b-instruct-q4_0
#   ./scripts/run-categorization-test.sh llama3.2:3b http://localhost:3080 http://localhost:11434
#
# Output:
#   - Runs category-specific diagnostic prompts
#   - Analyzes results to determine best category
#   - Calls ModelRegistry sync endpoint
#   - Returns recommended category and scores

set -e

# Color codes for output
GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
BOLD='\033[1m'
NC='\033[0m' # No Color

# Default configuration
BASE_URL="${2:-http://localhost:3080}"
OLLAMA_HOST="${3:-http://localhost:11434}"
MODEL_NAME="${1}"
PROMPTS_FILE="/home/yb/codes/AgentX/data/categorization-prompts.json"

# Validate inputs
if [ -z "$MODEL_NAME" ]; then
    echo -e "${RED}Error: Model name is required${NC}"
    echo ""
    echo "Usage: $0 <model-name> [base-url] [ollama-host]"
    echo ""
    echo "Examples:"
    echo "  $0 qwen2.5-7b-instruct-q4_0"
    echo "  $0 llama3.2:3b http://localhost:3080 http://localhost:11434"
    exit 1
fi

# Check if prompts file exists
if [ ! -f "$PROMPTS_FILE" ]; then
    echo -e "${RED}Error: Categorization prompts file not found at $PROMPTS_FILE${NC}"
    exit 1
fi

# Check if jq is installed
if ! command -v jq &> /dev/null; then
    echo -e "${RED}Error: jq is required but not installed${NC}"
    echo "Install with: sudo apt-get install jq (Ubuntu/Debian) or brew install jq (macOS)"
    exit 1
fi

echo -e "${CYAN}=========================================${NC}"
echo -e "${BOLD}Model Categorization Test${NC}"
echo -e "${CYAN}=========================================${NC}"
echo -e "Model:        ${BOLD}$MODEL_NAME${NC}"
echo -e "Base URL:     $BASE_URL"
echo -e "Ollama Host:  $OLLAMA_HOST"
echo -e "Prompts:      $PROMPTS_FILE"
echo ""

# Create temporary directory for results
TEMP_DIR=$(mktemp -d)
RESULTS_FILE="$TEMP_DIR/results.json"
BATCH_ID=""

echo -e "${BLUE}[1/5]${NC} Loading categorization prompts..."

# Count prompts by category
TOTAL_PROMPTS=$(jq '[.[] | select(.category_test == true)] | length' "$PROMPTS_FILE")
CODING_COUNT=$(jq '[.[] | select(.category_test == true and .category == "coding")] | length' "$PROMPTS_FILE")
REASONING_COUNT=$(jq '[.[] | select(.category_test == true and .category == "reasoning")] | length' "$PROMPTS_FILE")
FACTUAL_COUNT=$(jq '[.[] | select(.category_test == true and .category == "factual")] | length' "$PROMPTS_FILE")
MATH_COUNT=$(jq '[.[] | select(.category_test == true and .category == "math")] | length' "$PROMPTS_FILE")
CREATIVE_COUNT=$(jq '[.[] | select(.category_test == true and .category == "creative")] | length' "$PROMPTS_FILE")
GENERAL_COUNT=$(jq '[.[] | select(.category_test == true and .category == "general")] | length' "$PROMPTS_FILE")

echo -e "${GREEN}✓${NC} Loaded $TOTAL_PROMPTS categorization prompts:"
echo "  - Coding:    $CODING_COUNT prompts"
echo "  - Reasoning: $REASONING_COUNT prompts"
echo "  - Factual:   $FACTUAL_COUNT prompts"
echo "  - Math:      $MATH_COUNT prompts"
echo "  - Creative:  $CREATIVE_COUNT prompts"
echo "  - General:   $GENERAL_COUNT prompts"
echo ""

echo -e "${BLUE}[2/5]${NC} Creating benchmark batch..."

# Create batch with category_test tag
BATCH_RESPONSE=$(curl -s -X POST "$BASE_URL/api/benchmark/batch" \
    -H "Content-Type: application/json" \
    -d "{
        \"model\": \"$MODEL_NAME\",
        \"host\": \"$OLLAMA_HOST\",
        \"promptLevel\": null,
        \"promptCategory\": null,
        \"tags\": [\"category_test\", \"diagnostic\"]
    }")

BATCH_ID=$(echo "$BATCH_RESPONSE" | jq -r '.data._id // .data.id // empty')

if [ -z "$BATCH_ID" ]; then
    echo -e "${RED}✗ Failed to create batch${NC}"
    echo "Response: $BATCH_RESPONSE"
    rm -rf "$TEMP_DIR"
    exit 1
fi

echo -e "${GREEN}✓${NC} Created batch: $BATCH_ID"
echo ""

echo -e "${BLUE}[3/5]${NC} Running categorization tests..."
echo -e "${YELLOW}This may take several minutes depending on model size...${NC}"
echo ""

# Extract and run each categorization prompt
PROMPT_INDEX=0
jq -c '.[] | select(.category_test == true)' "$PROMPTS_FILE" | while read -r prompt_obj; do
    ((PROMPT_INDEX++))

    PROMPT_TEXT=$(echo "$prompt_obj" | jq -r '.prompt')
    PROMPT_NAME=$(echo "$prompt_obj" | jq -r '.name')
    PROMPT_CATEGORY=$(echo "$prompt_obj" | jq -r '.category')

    echo -e "  ${CYAN}[$PROMPT_INDEX/$TOTAL_PROMPTS]${NC} Testing ${BOLD}$PROMPT_CATEGORY${NC} - $PROMPT_NAME..."

    # Run benchmark test
    TEST_RESPONSE=$(curl -s -X POST "$BASE_URL/api/benchmark/test" \
        -H "Content-Type: application/json" \
        -d "{
            \"model\": \"$MODEL_NAME\",
            \"host\": \"$OLLAMA_HOST\",
            \"prompt\": $(echo "$PROMPT_TEXT" | jq -R -s .)
        }")

    # Check if test succeeded
    TEST_SUCCESS=$(echo "$TEST_RESPONSE" | jq -r '.data.success // false')

    if [ "$TEST_SUCCESS" = "true" ]; then
        LATENCY=$(echo "$TEST_RESPONSE" | jq -r '.data.latency // 0')
        TOKENS_PER_SEC=$(echo "$TEST_RESPONSE" | jq -r '.data.tokens_per_sec // 0')
        echo -e "    ${GREEN}✓${NC} Success - ${LATENCY}ms, ${TOKENS_PER_SEC} tok/s"
    else
        ERROR_MSG=$(echo "$TEST_RESPONSE" | jq -r '.data.error // "Unknown error"')
        echo -e "    ${RED}✗${NC} Failed - $ERROR_MSG"
    fi

    # Small delay to avoid overwhelming the model
    sleep 0.5
done

echo ""
echo -e "${GREEN}✓${NC} All tests completed"
echo ""

echo -e "${BLUE}[4/5]${NC} Analyzing results and calculating category scores..."

# Wait a moment for all results to be saved
sleep 2

# Fetch aggregated results from benchmark service
DASHBOARD_RESPONSE=$(curl -s "$BASE_URL/api/benchmark/dashboard?tag=category_test")

# Calculate scores per category by aggregating benchmark results
# This queries the actual BenchmarkResult collection for this model
CATEGORY_SCORES=$(curl -s "$BASE_URL/api/benchmark/results?model=$MODEL_NAME&limit=100" | \
    jq '[.data.results[] | select(.prompt_category != null)] |
        group_by(.prompt_category) |
        map({
            category: .[0].prompt_category,
            count: length,
            avg_quality: (map(.quality_score // 0) | add / length),
            avg_composite: (map(.composite_score // 0) | add / length),
            avg_latency: (map(.latency // 0) | add / length),
            success_rate: ((map(select(.success == true)) | length) / length * 100)
        }) |
        sort_by(-.avg_composite)')

echo "$CATEGORY_SCORES" | jq -r '.[] | "  \(.category | ascii_upcase): Score=\(.avg_composite | round) Quality=\(.avg_quality | round) Latency=\(.avg_latency | round)ms Success=\(.success_rate | round)%"'

# Determine recommended category (highest composite score)
RECOMMENDED_CATEGORY=$(echo "$CATEGORY_SCORES" | jq -r '.[0].category // "general"')
RECOMMENDED_SCORE=$(echo "$CATEGORY_SCORES" | jq -r '.[0].avg_composite // 0')

echo ""
echo -e "${GREEN}✓${NC} Analysis complete"
echo ""

echo -e "${BLUE}[5/5]${NC} Syncing results to ModelRegistry..."

# Sync benchmark stats to ModelRegistry
SYNC_RESPONSE=$(curl -s -X POST "$BASE_URL/api/models/registry/$MODEL_NAME/sync")
SYNC_STATUS=$(echo "$SYNC_RESPONSE" | jq -r '.status')

if [ "$SYNC_STATUS" = "success" ]; then
    echo -e "${GREEN}✓${NC} ModelRegistry updated successfully"

    # Fetch updated model to show benchmark stats
    MODEL_DATA=$(curl -s "$BASE_URL/api/models/registry/$MODEL_NAME")
    BEST_CATEGORY=$(echo "$MODEL_DATA" | jq -r '.data.benchmarkStats.bestCategory // "N/A"')
    WORST_CATEGORY=$(echo "$MODEL_DATA" | jq -r '.data.benchmarkStats.worstCategory // "N/A"')
    AVG_COMPOSITE=$(echo "$MODEL_DATA" | jq -r '.data.benchmarkStats.avgCompositeScore // 0')
    AVG_QUALITY=$(echo "$MODEL_DATA" | jq -r '.data.benchmarkStats.avgQualityScore // 0')
    TOTAL_TESTS=$(echo "$MODEL_DATA" | jq -r '.data.benchmarkStats.totalTests // 0')
else
    echo -e "${YELLOW}⚠${NC} ModelRegistry sync warning (model may not be registered)"
    BEST_CATEGORY=$RECOMMENDED_CATEGORY
    WORST_CATEGORY="N/A"
    AVG_COMPOSITE=$RECOMMENDED_SCORE
    AVG_QUALITY=0
    TOTAL_TESTS=$TOTAL_PROMPTS
fi

echo ""

# Final summary
echo -e "${CYAN}=========================================${NC}"
echo -e "${BOLD}Categorization Results${NC}"
echo -e "${CYAN}=========================================${NC}"
echo -e "Model:              ${BOLD}$MODEL_NAME${NC}"
echo -e "Recommended:        ${GREEN}${BOLD}$BEST_CATEGORY${NC}"
echo -e "Worst Category:     ${RED}$WORST_CATEGORY${NC}"
echo -e "Avg Composite:      $AVG_COMPOSITE"
echo -e "Avg Quality:        $AVG_QUALITY"
echo -e "Total Tests:        $TOTAL_TESTS"
echo -e "${CYAN}=========================================${NC}"
echo ""

echo -e "${BOLD}Category Breakdown:${NC}"
echo "$CATEGORY_SCORES" | jq -r '.[] |
    "  • \(.category | ascii_upcase) (\(.count) tests)
    Quality:  \(.avg_quality | round)/100
    Composite: \(.avg_composite | round)/100
    Latency:   \(.avg_latency | round)ms
    Success:   \(.success_rate | round)%
"'

echo ""
echo -e "${GREEN}✓ Categorization test complete!${NC}"
echo ""
echo -e "${BOLD}Next Steps:${NC}"
echo "  1. Review category scores above"
echo "  2. Update model categories: PATCH $BASE_URL/api/models/registry/$MODEL_NAME"
echo "  3. View detailed results: $BASE_URL/benchmark.html"
echo "  4. Check batch details: curl $BASE_URL/api/benchmark/batch/$BATCH_ID"
echo ""

# Cleanup
rm -rf "$TEMP_DIR"

# Return recommended category as exit message
echo -e "Recommended category for ${BOLD}$MODEL_NAME${NC}: ${GREEN}${BOLD}$BEST_CATEGORY${NC}"
exit 0
