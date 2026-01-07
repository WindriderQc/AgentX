# Benchmark System Update: Profiles & Scoring Refinement

**Date:** October 26, 2024
**Version:** 2.1
**Status:** ✅ Implemented

## Overview
The benchmark system has been upgraded to support task-specific profiling, improved scoring transparency, and better model filtering. These changes address the bias towards speed-optimized models and provide a fair evaluation ground for reasoning and coding models.

## Key Changes

### 1. Dual Ranking Profiles & Coding Profile
- **Interactive Profile:** Optimized for chat (40% Quality, 40% Latency, 20% Speed). Latency cap: 30s.
- **Reasoning Profile:** Optimized for deep thinking (80% Quality, 10% Latency, 10% Speed). Latency cap: 120s.
- **Coding Profile:** Optimized for code generation (70% Quality, 20% Latency, 10% Speed). Latency cap: 60s.
- **Implementation:** 
  - `src/services/qualityScorer.js`: Added profile configurations and updated scoring logic.
  - `src/services/benchmarkService.js`: Updated dashboard aggregation to calculate all profile scores dynamically.

### 2. 0-100 Scoring Scale
- Updated the scoring system to use a 0-100 scale (previously 0-10) for better granularity and readability.
- Quality scores from the LLM judge (0-10) are scaled to 0-100.

### 3. Judge Performance UI
- Added a new "Judge Performance" section to the benchmark dashboard.
- Displays average latency and evaluation counts for the judge model itself.
- Helps identify if the judge model is the bottleneck.

### 4. Embedding Model Filtering
- Updated `routes/ollama-hosts.js` to automatically filter out embedding models (e.g., `nomic-embed-text`, `bert`) from the model discovery process.
- Prevents non-chat models from cluttering the leaderboard with garbage results.

### 5. Complex Prompts
- Added Level 4 and 5 prompts to `data/benchmark-prompts.json`.
- **Reasoning:** Logical fallacy analysis, multi-step puzzles.
- **Coding:** Thread-safe singleton implementation, cycle detection algorithms.
- These prompts ensure that "Reasoning" and "Coding" profiles have sufficient difficulty to differentiate capable models.

## Verification
- **Backend:** Verified scoring logic with a test script covering all profiles and edge cases (fast/slow models).
- **Frontend:** Verified profile switching logic in `benchmark.html` ensures charts and leaderboards update correctly based on the selected profile.
