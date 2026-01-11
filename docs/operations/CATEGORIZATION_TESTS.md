# Model Categorization Test Suite

> **Navigation:** [CLAUDE.md](../../CLAUDE.md) → [Documentation Index](../INDEX.md) → Categorization Tests

> **Context:** Diagnostic benchmark prompts designed to determine a model's optimal category assignment. Complements the [Benchmark System](BENCHMARK_SYSTEM.md) and [Model Registry](../architecture/MODEL_REGISTRY.md).

---

## Overview

The Categorization Test Suite provides a standardized battery of diagnostic prompts to objectively determine a model's strengths and weaknesses across different task categories. This enables:

1. **Automated Category Assignment** - Data-driven recommendations instead of manual guessing
2. **Performance Profiling** - Understand where a model excels and struggles
3. **Routing Optimization** - Configure model routing based on empirical results
4. **Benchmarking Consistency** - Standardized tests across all models

---

## Architecture

### Files

| File | Purpose | Lines |
|------|---------|-------|
| `/data/categorization-prompts.json` | 42 diagnostic prompts across 6 categories | ~450 |
| `/scripts/run-categorization-test.sh` | Automated test runner with scoring | ~300 |
| `/docs/operations/CATEGORIZATION_TESTS.md` | This documentation | - |

### Categories Tested

Each category has **5-7 prompts** at levels 2-3 (moderate difficulty):

| Category | Prompts | Tests For | Example Prompt |
|----------|---------|-----------|----------------|
| **coding** | 7 | Code generation, syntax, algorithms | "Write a function that reverses a string" |
| **reasoning** | 7 | Logic, deduction, problem-solving | "Four people cross bridge with flashlight puzzle" |
| **factual** | 7 | Knowledge recall, accuracy | "What is the chemical symbol for gold?" |
| **math** | 7 | Calculations, formulas, word problems | "Solve quadratic equation: x² - 5x + 6 = 0" |
| **creative** | 7 | Writing, ideation, storytelling | "Write haiku about autumn" |
| **general** | 7 | Everyday tasks, mixed abilities | "How to organize digital photos?" |

**Total:** 42 diagnostic prompts

---

## Prompt Design Principles

### 1. Category Diagnostic Value

Each prompt is designed to be **clearly diagnostic** of its specific category:

```json
{
  "category": "coding",
  "prompt": "Write a function that checks if a string is a palindrome, ignoring spaces and case",
  "why_diagnostic": "Tests code syntax, string manipulation, case handling, boolean logic - all core coding skills"
}
```

**Anti-pattern:** Generic prompts that could apply to multiple categories
- Bad: "Explain how a car engine works" (could be factual OR general)
- Good: "What is the chemical symbol for gold?" (pure factual recall)

### 2. Level Consistency

All categorization prompts are **level 2-3**:
- Not too easy (avoid ceiling effects where all models score 100%)
- Not too hard (avoid floor effects where all models fail)
- Goldilocks zone for differentiation

### 3. Objective Scoring Criteria

Each prompt includes:
- `expected_answer` - Clear correct answer for automatic scoring
- `judge_criteria` - 4-5 specific evaluation points
- `scoring_type` - Maps to quality scorer logic

```json
{
  "expected_answer": "21. This is the Fibonacci sequence where each number is the sum of the previous two: 8 + 13 = 21",
  "judge_criteria": [
    "Correct answer of 21",
    "Identifies Fibonacci pattern",
    "Shows the addition",
    "Clear explanation"
  ],
  "scoring_type": "reasoning"
}
```

### 4. Category Test Flag

All categorization prompts include `"category_test": true` to distinguish them from regular benchmark prompts:

```json
{
  "category_test": true,
  "name": "FizzBuzz",
  "category": "coding",
  ...
}
```

This enables:
- Filtering in batch creation
- Specialized analysis
- Separate leaderboards

---

## Usage

### Quick Start

```bash
# Run categorization test on a model
./scripts/run-categorization-test.sh qwen2.5-7b-instruct-q4_0

# Specify custom base URL and Ollama host
./scripts/run-categorization-test.sh llama3.2:3b http://localhost:3080 http://localhost:11434
```

### What the Script Does

**[1/5] Load Prompts**
- Reads `/data/categorization-prompts.json`
- Filters to `category_test: true` prompts
- Shows count per category

**[2/5] Create Batch**
- POSTs to `/api/benchmark/batch`
- Tags batch as `category_test` and `diagnostic`
- Returns batch ID for tracking

**[3/5] Run Tests**
- Iterates through all 42 prompts
- POSTs to `/api/benchmark/test` for each
- Shows progress with latency and tokens/sec
- Saves results to `BenchmarkResult` collection

**[4/5] Analyze Results**
- Queries `/api/benchmark/results?model=<name>`
- Groups by `prompt_category`
- Calculates per-category:
  - Average quality score
  - Average composite score
  - Average latency
  - Success rate
- Ranks categories by composite score

**[5/5] Sync to ModelRegistry**
- POSTs to `/api/models/registry/<name>/sync`
- Updates `benchmarkStats.bestCategory`
- Updates `benchmarkStats.worstCategory`
- Updates average scores and test counts

### Sample Output

```
=========================================
Model Categorization Test
=========================================
Model:        qwen2.5-7b-instruct-q4_0
Base URL:     http://localhost:3080
Ollama Host:  http://localhost:11434
Prompts:      /home/yb/codes/AgentX/data/categorization-prompts.json

[1/5] Loading categorization prompts...
✓ Loaded 42 categorization prompts:
  - Coding:    7 prompts
  - Reasoning: 7 prompts
  - Factual:   7 prompts
  - Math:      7 prompts
  - Creative:  7 prompts
  - General:   7 prompts

[2/5] Creating benchmark batch...
✓ Created batch: 507f1f77bcf86cd799439011

[3/5] Running categorization tests...
This may take several minutes depending on model size...

  [1/42] Testing CODING - String Reversal...
    ✓ Success - 1247ms, 45 tok/s
  [2/42] Testing CODING - FizzBuzz...
    ✓ Success - 1893ms, 38 tok/s
  ...
  [42/42] Testing GENERAL - Plant Care...
    ✓ Success - 987ms, 52 tok/s

✓ All tests completed

[4/5] Analyzing results and calculating category scores...
  CODING: Score=78 Quality=82 Latency=1456ms Success=100%
  REASONING: Score=71 Quality=75 Latency=2134ms Success=100%
  FACTUAL: Score=85 Quality=88 Latency=891ms Success=100%
  MATH: Score=68 Quality=72 Latency=1234ms Success=100%
  CREATIVE: Score=62 Quality=65 Latency=1678ms Success=100%
  GENERAL: Score=80 Quality=83 Latency=1045ms Success=100%

✓ Analysis complete

[5/5] Syncing results to ModelRegistry...
✓ ModelRegistry updated successfully

=========================================
Categorization Results
=========================================
Model:              qwen2.5-7b-instruct-q4_0
Recommended:        factual
Worst Category:     creative
Avg Composite:      74.0
Avg Quality:        77.5
Total Tests:        42
=========================================

Category Breakdown:
  • FACTUAL (7 tests)
    Quality:  88/100
    Composite: 85/100
    Latency:   891ms
    Success:   100%

  • GENERAL (7 tests)
    Quality:  83/100
    Composite: 80/100
    Latency:   1045ms
    Success:   100%

  • CODING (7 tests)
    Quality:  82/100
    Composite: 78/100
    Latency:   1456ms
    Success:   100%

  • REASONING (7 tests)
    Quality:  75/100
    Composite: 71/100
    Latency:   2134ms
    Success:   100%

  • MATH (7 tests)
    Quality:  72/100
    Composite: 68/100
    Latency:   1234ms
    Success:   100%

  • CREATIVE (7 tests)
    Quality:  65/100
    Composite: 62/100
    Latency:   1678ms
    Success:   100%

✓ Categorization test complete!

Next Steps:
  1. Review category scores above
  2. Update model categories: PATCH http://localhost:3080/api/models/registry/qwen2.5-7b-instruct-q4_0
  3. View detailed results: http://localhost:3080/benchmark.html
  4. Check batch details: curl http://localhost:3080/api/benchmark/batch/507f1f77bcf86cd799439011

Recommended category for qwen2.5-7b-instruct-q4_0: factual
```

---

## Interpreting Results

### Recommended Category

The script recommends the category with the **highest average composite score**. This represents the model's strongest area.

**Example:**
- If `factual` scores 85/100 composite, it's the recommended category
- This suggests the model excels at knowledge recall and accuracy

### Worst Category

The category with the **lowest average composite score**. Use this to identify weaknesses.

**Example:**
- If `creative` scores 62/100, avoid using this model for creative writing tasks

### Score Thresholds

| Composite Score | Interpretation | Action |
|-----------------|----------------|--------|
| **80-100** | Excellent | Primary category, configure routing preference |
| **60-79** | Good | Secondary category, suitable but not optimal |
| **40-59** | Fair | Avoid for this task type |
| **0-39** | Poor | Definitely avoid, add to routing `avoidFor` |

### Multi-Category Models

Some models may score well across multiple categories:

```
FACTUAL:   85/100  ← Recommended
GENERAL:   80/100  ← Also strong
CODING:    78/100  ← Also strong
```

**Action:** Assign multiple categories in ModelRegistry:
```bash
curl -X PATCH http://localhost:3080/api/models/registry/model-name \
  -H "Content-Type: application/json" \
  -d '{"categories": ["factual", "general", "coding"]}'
```

---

## Integration with ModelRegistry

### Automatic Sync

The categorization test automatically updates `ModelRegistry.benchmarkStats`:

```javascript
{
  benchmarkStats: {
    avgCompositeScore: 74.0,     // Overall performance
    avgQualityScore: 77.5,       // Average quality across all tests
    bestCategory: "factual",     // Highest scoring category
    worstCategory: "creative",   // Lowest scoring category
    totalTests: 42,              // Number of categorization tests run
    lastBenchmarked: "2026-01-10T..."
  }
}
```

### Manual Category Assignment

While the script identifies the **best** category, you may want to assign multiple categories:

```bash
# Add recommended category
curl -X POST http://localhost:3080/api/models/registry/model-name/categories \
  -H "Content-Type: application/json" \
  -d '{"category": "factual"}'

# Add secondary categories if scores are good (>70)
curl -X POST http://localhost:3080/api/models/registry/model-name/categories \
  -H "Content-Type: application/json" \
  -d '{"category": "general"}'
```

### Routing Configuration

Use categorization results to configure routing preferences:

```bash
# Set preferred task types based on best category
curl -X PATCH http://localhost:3080/api/models/registry/model-name \
  -H "Content-Type: application/json" \
  -d '{
    "routingRules": {
      "preferredFor": ["factual_qa", "knowledge_retrieval"],
      "avoidFor": ["creative_writing", "story_generation"],
      "priority": 8
    }
  }'
```

---

## Adding New Categorization Prompts

### Template

```json
{
  "level": 2,
  "category": "coding",
  "category_test": true,
  "name": "Descriptive Test Name",
  "prompt": "Clear, unambiguous prompt text that tests a specific skill",
  "expected_tokens": 120,
  "expected_answer": "Clear description of correct answer with key elements",
  "judge_criteria": [
    "First evaluation criterion (most important)",
    "Second evaluation criterion",
    "Third evaluation criterion",
    "Fourth evaluation criterion"
  ],
  "scoring_type": "code"
}
```

### Guidelines

1. **Category Test Flag**
   - Always include `"category_test": true`
   - This distinguishes diagnostic prompts from general benchmarks

2. **Level Balance**
   - Keep prompts at level 2-3
   - Avoid level 1 (too easy) and level 4-5 (too hard)
   - Goal is to differentiate models, not make all fail or all succeed

3. **Category Specificity**
   - Each prompt should clearly test one category
   - Avoid prompts that blur category lines
   - Example: "Write a poem about calculus" mixes creative + math

4. **Objective Criteria**
   - `expected_answer` should include concrete details
   - `judge_criteria` should be verifiable
   - Avoid subjective criteria like "creative enough"

5. **Scoring Type Alignment**
   - `"scoring_type": "code"` for coding category
   - `"scoring_type": "reasoning"` for reasoning category
   - `"scoring_type": "factual"` for factual category
   - `"scoring_type": "math"` for math category
   - `"scoring_type": "creative"` for creative category
   - `"scoring_type": "general"` for general category

### Validation

After adding prompts, validate the JSON:

```bash
# Check JSON syntax
jq . /home/yb/codes/AgentX/data/categorization-prompts.json > /dev/null && echo "Valid JSON"

# Count category_test prompts
jq '[.[] | select(.category_test == true)] | length' /home/yb/codes/AgentX/data/categorization-prompts.json

# Count by category
jq '[.[] | select(.category_test == true)] | group_by(.category) | map({category: .[0].category, count: length})' /home/yb/codes/AgentX/data/categorization-prompts.json
```

---

## Comparison with Regular Benchmarks

| Aspect | Regular Benchmarks | Categorization Tests |
|--------|-------------------|----------------------|
| **Purpose** | General performance testing | Category assignment |
| **Scope** | All levels (1-5), all categories | Level 2-3 only, all categories |
| **Flag** | `category_test: false` or absent | `category_test: true` |
| **Prompt Count** | ~20 regular prompts | 42 diagnostic prompts |
| **Tags** | `production`, `experimental`, etc. | `category_test`, `diagnostic` |
| **Frequency** | Run periodically for monitoring | Run once during model onboarding |
| **Output** | Performance metrics, leaderboard | Recommended category |

---

## Troubleshooting

### Model Not Found Error

**Symptom:**
```
✗ ModelRegistry sync warning (model may not be registered)
```

**Cause:** Model doesn't exist in ModelRegistry

**Fix:**
```bash
# Register model first
curl -X POST http://localhost:3080/api/models/registry \
  -H "Content-Type: application/json" \
  -d '{
    "modelName": "qwen2.5-7b-instruct-q4_0",
    "displayName": "Qwen 2.5 7B Instruct",
    "vendor": "alibaba",
    "categories": [],
    "isActive": true
  }'

# Then run categorization test
./scripts/run-categorization-test.sh qwen2.5-7b-instruct-q4_0
```

### All Tests Failing

**Symptom:**
```
[1/42] Testing CODING - String Reversal...
  ✗ Failed - Connection refused
```

**Cause:** Ollama host not reachable or model not pulled

**Fix:**
```bash
# Check Ollama is running
curl http://localhost:11434/api/version

# Pull model if needed
ollama pull qwen2.5-7b-instruct-q4_0

# Retry with explicit host
./scripts/run-categorization-test.sh qwen2.5-7b-instruct-q4_0 http://localhost:3080 http://localhost:11434
```

### No Category Breakdown

**Symptom:** Category scores show empty or null

**Cause:** Results not saved to database yet

**Fix:** The script includes a 2-second delay. If still failing:
```bash
# Wait a few seconds, then manually query
sleep 5
curl "http://localhost:3080/api/benchmark/results?model=qwen2.5-7b-instruct-q4_0&limit=100"
```

### JQ Command Not Found

**Symptom:**
```
Error: jq is required but not installed
```

**Fix:**
```bash
# Ubuntu/Debian
sudo apt-get install jq

# macOS
brew install jq

# Verify installation
jq --version
```

---

## API Endpoints Used

The categorization script uses these endpoints:

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/api/benchmark/batch` | POST | Create test batch with tags |
| `/api/benchmark/test` | POST | Run individual test |
| `/api/benchmark/results` | GET | Fetch results for analysis |
| `/api/benchmark/dashboard` | GET | Aggregate dashboard data |
| `/api/models/registry/:name/sync` | POST | Update ModelRegistry stats |
| `/api/models/registry/:name` | GET | Fetch model details |

---

## Future Enhancements

### Planned Features

1. **Adaptive Difficulty**
   - Start at level 2
   - Increase to level 3 if model scores >80%
   - Decrease to level 1 if model scores <40%

2. **Confidence Intervals**
   - Run each category 2-3 times
   - Calculate standard deviation
   - Report confidence range (e.g., "coding: 78 ± 4")

3. **Comparative Analysis**
   - Compare against existing models in same category
   - Show percentile rank (e.g., "Top 25% of coding models")

4. **Recommendation Engine**
   - Suggest optimal `routingRules.preferredFor` values
   - Auto-generate `routingRules.avoidFor` for low-scoring categories

5. **Historical Tracking**
   - Track category performance over time
   - Detect regression after model updates

---

## Related Documentation

- [Benchmark System](BENCHMARK_SYSTEM.md) - Overall benchmarking architecture
- [Benchmark Quality Scoring](BENCHMARK_QUALITY_SCORING.md) - How scoring works
- [Model Registry](../architecture/MODEL_REGISTRY.md) - Category schema and usage
- [Model Routing](../architecture/MODEL_ROUTING.md) - How categories affect routing

---

**Back to:** [CLAUDE.md](../../CLAUDE.md) | [Documentation Index](../INDEX.md)
