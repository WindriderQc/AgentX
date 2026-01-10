RESTORE CONTEXT: Recommended Category Feature for Benchmark System
Problem Statement
The benchmark page has category tabs (Universal, Coding, Embedding, Reasoning, etc.) that filter models based on manually assigned categories in ModelRegistry. User wants models to show a "Recommended Category" based on actual benchmark performance, not just manual tags.

Current System
ModelRegistry.categories = Manual tags (ops, coding, reasoning, specialist, generalist, embedding, judge)
BenchmarkResult.prompt_category = Category of the test prompt (coding, reasoning, factual, etc.)
Category tabs call filterByModelCategory() which queries ModelRegistry.findByCategory()
Models appear in wrong tabs because they're manually mis-categorized or not categorized at all
Bug Fix Already Applied
Fixed in src/services/benchmarkService.js lines 376-382:

Failure-only models now filter by category (was showing ALL failures in every tab)
Added stable sort tie-breaker by model name for consistent ordering
Feature Request (Multi-Phase)
Phase 1: Add "Recommended Category" column to Model Registry UI

Calculate based on which prompt_category the model scores best on
Show alongside manual category for comparison
Phase 2: Dedicated categorization tests

Specific test suite to determine model strengths
Quick classification benchmark
Phase 3: Web search integration

Fetch model info from web to help categorization
Model cards, documentation, etc.
Phase 4: Categorization config/setup page

Dedicated UI for managing model categories
Batch categorization tools
Category rules configuration
Key Files
/models/ModelRegistry.js - Schema with categories field
/models/BenchmarkResult.js - Has prompt_category field
/src/services/benchmarkService.js - Dashboard/stats logic
/public/benchmark.html - Frontend UI (category tabs, leaderboard)
/public/js/benchmark-analytics.js - Filter logic
Next Steps
Explore how prompt_category scores are aggregated per model
Design recommendation algorithm (best performing category)
Add to Model Registry API response
Display in UI (both benchmark leaderboard and model management)
Commands to Start

# Check prompt categories in use
grep -r "prompt_category" models/ src/services/

# Find Model Registry UI
grep -r "modelRegistry\|ModelRegistry" public/
Copy this to continue after reboot!