/**
 * In-flight benchmark request registry: the single owner of the per-batch
 * AbortController sets used by the stop route and lease-loss handling.
 */

// A throughput batch can have one in-flight Core request per host. Keep the
// controllers grouped by the exact batch id so the stop route can interrupt
// only the requested batch without coupling execution.js to prompt internals.
const activeBatchControllers = new Map();
const userStoppedControllers = new WeakSet();

function registerActiveBatchController(batchId, controller) {
    const key = String(batchId);
    let controllers = activeBatchControllers.get(key);
    if (!controllers) {
        controllers = new Set();
        activeBatchControllers.set(key, controllers);
    }
    controllers.add(controller);

    let registered = true;
    return () => {
        if (!registered) return false;
        registered = false;

        // A late cleanup must not touch a newer Set created for the same batch.
        const currentControllers = activeBatchControllers.get(key);
        if (currentControllers !== controllers) return false;

        const removed = currentControllers.delete(controller);
        if (currentControllers.size === 0 && activeBatchControllers.get(key) === controllers) {
            activeBatchControllers.delete(key);
        }
        return removed;
    };
}

function abortActiveBatchRequests(batchId, options = {}) {
    const key = String(batchId);
    const controllers = activeBatchControllers.get(key);
    if (!controllers) {
        return { batchId: key, activeRequestCount: 0, abortedRequestCount: 0 };
    }

    let abortedRequestCount = 0;
    for (const controller of controllers) {
        if (controller.signal.aborted) continue;

        const userInitiated = options.userInitiated !== false;
        if (userInitiated) userStoppedControllers.add(controller);
        const reason = options.reason instanceof Error
            ? options.reason
            : new Error(`Benchmark batch ${key} stopped by user`);
        if (userInitiated) {
            reason.name = 'BenchmarkBatchStoppedError';
            reason.code = 'BENCHMARK_BATCH_STOPPED';
        }
        controller.abort(reason);
        abortedRequestCount += 1;
    }

    return {
        batchId: key,
        activeRequestCount: controllers.size,
        abortedRequestCount
    };
}

function wasControllerStoppedByUser(controller) {
    return !!controller && (
        userStoppedControllers.has(controller)
        || controller.signal?.reason?.code === 'BENCHMARK_BATCH_STOPPED'
    );
}

function getActiveBatchRequestCount(batchId) {
    return activeBatchControllers.get(String(batchId))?.size || 0;
}

module.exports = {
    registerActiveBatchController,
    abortActiveBatchRequests,
    wasControllerStoppedByUser,
    getActiveBatchRequestCount
};
