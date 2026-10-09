'use strict';

// Preloaded into a real Benchmark server process (node --require). Batch
// execution is replaced by a fixture: the process reports the batch named by
// BENCHMARK_FIXTURE_ACTIVE_BATCH as its own running batch, without Ollama.
const execution = require('../../src/services/benchmark/execution');
execution.getActiveBatchId = () => process.env.BENCHMARK_FIXTURE_ACTIVE_BATCH || null;
