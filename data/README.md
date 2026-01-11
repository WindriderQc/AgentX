# Data Directory

This directory contains JSON data files for the AgentX benchmark system.

## Files

### benchmark-prompts.json

Regular benchmark prompts used for general model performance testing.

- **Purpose:** Comprehensive benchmarking across all levels and categories
- **Levels:** 1-5 (from simple to expert)
- **Categories:** coding, reasoning, factual, math, creative, general
- **Count:** ~20 prompts
- **Usage:** Standard benchmark batches and leaderboards

### categorization-prompts.json

**Diagnostic prompts specifically designed to determine a model's optimal category assignment.**

- **Purpose:** Automated category recommendation for model registry
- **Levels:** 2-3 only (moderate difficulty for differentiation)
- **Categories:** coding, reasoning, factual, math, creative, general
- **Count:** 42 prompts (7 per category)
- **Flag:** `"category_test": true` to distinguish from regular benchmarks
- **Usage:** Run via `/scripts/run-categorization-test.sh`

**Key Features:**
- Each prompt is clearly diagnostic of its specific category
- Designed to avoid ceiling/floor effects (not too easy or hard)
- Includes objective `expected_answer` and `judge_criteria` for scoring
- Used for model onboarding and category profiling

**Example:**

```json
{
  "level": 2,
  "category": "coding",
  "category_test": true,
  "name": "String Reversal",
  "prompt": "Write a function that reverses a string without using built-in reverse methods",
  "expected_tokens": 120,
  "expected_answer": "A function that uses a loop or recursion to reverse a string character by character",
  "judge_criteria": [
    "Valid function with string parameter",
    "Manually reverses without .reverse() or similar",
    "Returns correctly reversed string",
    "Code is syntactically correct"
  ],
  "scoring_type": "code"
}
```

## Documentation

- [Benchmark System](../docs/operations/BENCHMARK_SYSTEM.md) - Overview of benchmarking architecture
- [Categorization Tests](../docs/operations/CATEGORIZATION_TESTS.md) - Complete guide to category testing
- [Model Registry](../docs/architecture/MODEL_REGISTRY.md) - Category schema and integration

## Scripts

- `/scripts/run-categorization-test.sh` - Automated categorization test runner
- `/scripts/test-category-filtering.sh` - Integration tests for category filtering

## Usage Examples

### Run Regular Benchmarks

```bash
# Via API
curl -X POST http://localhost:3080/api/benchmark/batch \
  -H "Content-Type: application/json" \
  -d '{
    "model": "qwen2.5-7b-instruct-q4_0",
    "host": "http://localhost:11434",
    "promptLevel": 2,
    "promptCategory": "coding"
  }'
```

### Run Categorization Tests

```bash
# Via script (recommended)
./scripts/run-categorization-test.sh qwen2.5-7b-instruct-q4_0

# Output includes recommended category and scores per category
```

## Adding New Prompts

### Regular Benchmarks

Add to `benchmark-prompts.json`:
- Include all required fields: level, category, name, prompt, expected_tokens, expected_answer, judge_criteria, scoring_type
- Do NOT include `category_test` flag (or set to false)
- Can be any level (1-5)

### Categorization Tests

Add to `categorization-prompts.json`:
- **MUST** include `"category_test": true`
- **MUST** be level 2 or 3 only
- **MUST** be clearly diagnostic of one specific category
- Follow template in [CATEGORIZATION_TESTS.md](../docs/operations/CATEGORIZATION_TESTS.md#adding-new-categorization-prompts)

## Validation

Validate JSON syntax and structure:

```bash
# Check syntax
jq . data/benchmark-prompts.json > /dev/null && echo "Valid"
jq . data/categorization-prompts.json > /dev/null && echo "Valid"

# Count category test prompts
jq '[.[] | select(.category_test == true)] | length' data/categorization-prompts.json

# Count by category
jq 'group_by(.category) | map({category: .[0].category, count: length})' data/categorization-prompts.json
```

## Schema

All prompts follow this schema:

```typescript
interface BenchmarkPrompt {
  level: 1 | 2 | 3 | 4 | 5;
  category: 'coding' | 'reasoning' | 'factual' | 'math' | 'creative' | 'general';
  category_test?: boolean;  // Only for categorization prompts
  name: string;
  prompt: string;
  expected_tokens: number;
  expected_answer: string;
  judge_criteria: string[];
  scoring_type: 'code' | 'reasoning' | 'factual' | 'math' | 'creative' | 'general';
}
```

## Related Files

- `/models/BenchmarkPrompt.js` - Mongoose schema
- `/models/BenchmarkResult.js` - Test results schema
- `/models/BenchmarkBatch.js` - Batch execution schema
- `/models/ModelRegistry.js` - Model metadata with category assignment
