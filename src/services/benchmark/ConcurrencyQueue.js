/**
 * Concurrency Queue for managing parallel tasks with rate limiting
 * Used primarily for judge tasks to prevent overwhelming the LLM host
 */

const logger = require('../../../config/logger');

class ConcurrencyQueue {
    constructor(concurrency) {
        this.concurrency = concurrency;
        this.running = 0;
        this.queue = [];
        this.activePromises = [];
        this.completed = 0;
        this.failed = 0;
        this.lastActivityAt = Date.now();
    }

    add(task) {
        return new Promise((resolve, reject) => {
            this.queue.push({ task, resolve, reject, addedAt: Date.now() });
            logger.debug('Judge task queued', { queueLength: this.queue.length, running: this.running });
            this.process();
        });
    }

    process() {
        // Fill up to concurrency limit (not just one task per call)
        while (this.running < this.concurrency && this.queue.length > 0) {
            this.running++;
            const { task, resolve, reject } = this.queue.shift();
            logger.debug('Starting judge task', { running: this.running, queueLength: this.queue.length });

            const promise = (async () => {
                try {
                    const result = await task();
                    this.completed++;
                    this.lastActivityAt = Date.now();
                    logger.debug('Judge task completed', { completed: this.completed, failed: this.failed });
                    resolve(result);
                } catch (err) {
                    this.failed++;
                    this.lastActivityAt = Date.now();
                    logger.warn('Judge task failed', { error: err.message, completed: this.completed, failed: this.failed });
                    reject(err);
                } finally {
                    this.running--;
                    const idx = this.activePromises.indexOf(promise);
                    if (idx > -1) this.activePromises.splice(idx, 1);
                    this.process();  // Refill when a slot opens
                }
            })();

            this.activePromises.push(promise);
        }
    }

    /**
     * Get current queue status for monitoring
     */
    getStatus() {
        return {
            queued: this.queue.length,
            running: this.running,
            completed: this.completed,
            failed: this.failed,
            lastActivityAt: this.lastActivityAt,
            stalledMs: Date.now() - this.lastActivityAt
        };
    }

    /**
     * Drain the queue with timeout protection
     * @param {Object} options - Drain options
     * @param {number} options.timeoutMs - Maximum time to wait (default: 30 minutes)
     * @param {number} options.stallTimeoutMs - Max time without activity before considered stalled (default: 2 minutes)
     * @param {function} options.onProgress - Callback for progress updates
     * @returns {Promise<{completed: number, failed: number, timedOut: boolean}>}
     */
    async drain(options = {}) {
        const {
            timeoutMs = 30 * 60 * 1000,  // 30 minutes max
            stallTimeoutMs = 2 * 60 * 1000,  // 2 minutes stall detection
            onProgress = null
        } = options;

        const startTime = Date.now();
        let lastProgressReport = Date.now();

        while (this.queue.length > 0 || this.running > 0) {
            const elapsed = Date.now() - startTime;
            const stalledFor = Date.now() - this.lastActivityAt;

            // Check for overall timeout
            if (elapsed > timeoutMs) {
                logger.warn('Judge queue drain timed out', {
                    elapsed,
                    queued: this.queue.length,
                    running: this.running,
                    completed: this.completed,
                    failed: this.failed
                });
                return { completed: this.completed, failed: this.failed, timedOut: true, reason: 'timeout' };
            }

            // Check for stall (no activity for stallTimeoutMs)
            if (stalledFor > stallTimeoutMs && (this.queue.length > 0 || this.running > 0)) {
                logger.warn('Judge queue appears stalled', {
                    stalledFor,
                    queued: this.queue.length,
                    running: this.running,
                    completed: this.completed,
                    failed: this.failed
                });
                return { completed: this.completed, failed: this.failed, timedOut: true, reason: 'stalled' };
            }

            // Report progress every 10 seconds
            if (onProgress && Date.now() - lastProgressReport > 10000) {
                onProgress(this.getStatus());
                lastProgressReport = Date.now();
            }

            await new Promise(resolve => setTimeout(resolve, 100));
        }

        return { completed: this.completed, failed: this.failed, timedOut: false };
    }
}

module.exports = ConcurrencyQueue;
