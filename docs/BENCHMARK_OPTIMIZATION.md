# Benchmark Performance Optimization Report

## Analysis of "Rushing" and App Load Issues

During the analysis of the benchmark batch execution system, several performance bottlenecks were identified that contribute to high application load and the "rushing" behavior reported by users.

### 1. Redundant Hardware Detection (Major)
**Findings:**
- The `scoreResponse` function in `qualityScorer.js` attempts to detect hardware info (VRAM, backend) for the judge host on *every* single judge call if a cached snapshot is not provided.
- `executeBatch` was not providing this cached snapshot, resulting in one extra network request to `${judgeHost}/api/ps` for every benchmark test.
- For a batch of 100 tests, this adds 100 unnecessary API calls, increasing latency and noise.

**Recommendation:**
- Capture the judge hardware snapshot once per host at the start of the batch (after warmup) and reuse it for all judge calls.

### 2. Excessive Database I/O Density
**Findings:**
- Each benchmark test completion currently triggers multiple separate database updates:
    1. `updateCurrentTest` (Timeline + Status)
    2. `recordTestComplete` (Timeline)
    3. Batch progress increment (Completed count + Results summary)
- Combined with judging updates, this results in approximately 6-7 DB round-trips per test.
- This high density of writes can overwhelm the application process and the database during fast-running benchmarks.

**Recommendation:**
- Consolidate timeline recording and progress updates into a single atomic `updateOne` call per test.

### 3. Asynchronous Judge Queue Pressure
**Findings:**
- Quality scoring (judging) is performed asynchronously via a `ConcurrencyQueue`.
- The test execution loop adds tasks to this queue without waiting for them to complete.
- If model responses are fast (e.g., short prompts), the queue can grow rapidly, causing the app server to manage many concurrent background network and database operations.

**Recommendation:**
- Implement "soft backpressure" by pausing the test execution loop if the judge queue length exceeds a reasonable threshold (e.g., 10 pending tasks).

### 4. Hardware Profile Aggregate Logic
**Findings:**
- `updateProfile` runs at the end of every batch for each unique model/host combination.
- It performs a `BenchmarkResult.find()` for the last 7 days of data.
- For large batches with many models, this creates a significant I/O spike at the end of the run.

**Recommendation:**
- Monitor and potentially background these aggregate calculations.

## Proposed Optimization Plan

1. **Implement Caching:** Capture judge hardware snapshots once per host in `executeBatch`.
2. **Consolidate Writes:** Merge `recordTestComplete` and progress updates.
3. **Add Backpressure:** Throttling in the test loop based on judge queue status.

These changes will significantly reduce the per-test overhead on both the network and the database, leading to a smoother and more stable benchmarking experience.
