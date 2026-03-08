# Benchmark Reliability Plan

This plan is ordered by impact on benchmark trustworthiness:

1. Execution efficiency
- Reduce per-test write amplification in batch execution.
- Keep progress counters authoritative while allowing buffered updates.
- Continue removing avoidable network/runtime overhead from benchmark and judge paths.

Status:
- Launched. Batch execution now buffers progress/result writes and flushes in small batches.
- Launched. Judge HTTP calls now use the shared stable fetch helper.
- Launched. `throughput` mode now throttles `current_test` persistence to reduce hot-path batch writes.

2. Judge exactitude
- Escalate from single-judge scoring to multi-judge consensus when confidence is low, review is required, or a judge fails.
- Preserve consensus metadata and per-judge audit records on each benchmark result.
- Expand calibration coverage with human-scored gold cases by category and difficulty.

Status:
- Launched. Confidence-driven multi-judge escalation is active in the benchmark judging pipeline.
- Launched. Calibration gold set and calibration metrics module are in place for CI and future reporting.

3. Recovery and state reconciliation
- Verify batch state after crashes, queue stalls, and partial judging.
- Keep API-visible counters aligned with authoritative result counts.
- Expand regression coverage for preflight failure, judge drift, and recovery flows.

Status:
- Launched. Judge crash persistence, counter reconciliation, and preflight regression coverage are in the benchmark test suite.
- Launched. Manual recover and stale-batch cleanup now reconcile execution and judge counters from authoritative result data.
- Launched. Recovery paths now clear stale `current_test` state and release the active batch slot.

4. CI release gating
- Add benchmark-specific regression gates separate from generic app tests.
- Keep benchmark lifecycle, judge calibration, and multi-judge behavior protected in CI.

Status:
- Launched. CI now includes a dedicated benchmark regression job.

5. Next tranche
- Add richer calibration corpora for more categories and disagreement archetypes.
- Reduce `recordTestComplete()` and `current_test` write frequency if profiling shows they remain hot.
- Add benchmark analytics for escalation rate, consensus rate, and calibration drift over time.
- Add benchmark-specific crash and resume tests around live execution worker shutdown.
