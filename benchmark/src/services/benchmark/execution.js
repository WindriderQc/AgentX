/**
 * Benchmark Execution Module
 * Core batch management, orchestration, and progress tracking
 */

const { runTest } = require('./testExecution');
const { startBatch } = require('./batchStart');
const { resumeBatch } = require('./batchResume');
const { executeBatch } = require('./batchExecutionRun');
const { stopBatch } = require('./batchStop');
const {
    getActiveBatchId,
    getActiveHeartbeatInterval,
    clearActiveBatch
} = require('./batchActiveState');

module.exports = {
    runTest,
    startBatch,
    resumeBatch,
    executeBatch,
    stopBatch,
    getActiveBatchId,
    getActiveHeartbeatInterval,
    clearActiveBatch
};
