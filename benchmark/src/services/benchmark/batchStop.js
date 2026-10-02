/**
 * Batch stop: durable user stop transition, in-flight request abort and
 * authoritative reconciliation from results.
 */

const logger = require('../../../config/logger');
const BenchmarkBatch = require('../../../models/BenchmarkBatch');
const BenchmarkTimelineEntry = require('../../../models/BenchmarkTimelineEntry');
const { abortActiveBatchRequests } = require('./batchOrchestrator');
const { buildIdleCurrentTest } = require('./batchHelpers');
const { getActiveBatchId } = require('./batchActiveState');

async function stopBatch(batchId) {
    const stoppedAt = new Date();
    const managedLocally = getActiveBatchId() === String(batchId);
    // Establish the user stop as durable truth before interrupting work. This
    // small atomic write releases the singleton slot even if authoritative
    // counter reconciliation later fails.
    let batch = await BenchmarkBatch.findOneAndUpdate(
        {
            _id: batchId,
            status: { $in: ['pending', 'running'] }
        },
        {
            $set: {
                status: 'stopped',
                judge_status: 'stopped',
                completed_at: stoppedAt,
                last_activity_at: stoppedAt,
                current_test: buildIdleCurrentTest(),
                active_slot: null,
                execution_pid: null
            }
        },
        { new: true }
    );

    if (!batch) {
        batch = await BenchmarkBatch.findById(batchId);
        if (!batch) {
            throw new Error('Batch not found');
        }
        if (batch.status === 'stopped') {
            // Safe to repeat: already-aborted controllers are ignored.
            abortActiveBatchRequests(batchId);
        }
        return { batch, alreadyStopped: true, managedLocally };
    }

    abortActiveBatchRequests(batchId);

    await BenchmarkTimelineEntry.create({
        batchId,
        timestamp: stoppedAt,
        event: 'stop_requested',
        success: false,
        error: null
    }).catch(() => {});

    try {
        batch = await batch.reconcileFromResults({ status: 'stopped' });
    } catch (err) {
        // The stop intent is already committed. Reconciliation is valuable,
        // but its failure must never resurrect the runner or turn a successful
        // stop into an HTTP 500.
        logger.warn('Batch stopped but authoritative reconciliation failed', {
            batchId,
            error: err.message
        });
    } finally {
        // Catch a request registered between the durable transition and the
        // first abort pass.
        abortActiveBatchRequests(batchId);
    }
    logger.info('Batch stopped by user', { batchId });

    return { batch, alreadyStopped: false, managedLocally };
}

module.exports = { stopBatch };
