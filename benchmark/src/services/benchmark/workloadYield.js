'use strict';

/**
 * Household priority over benchmark workloads (#62), benchmark side.
 *
 * Before each of its inference requests a workload passes Core's yield point
 * with its admission proof and the number of its own requests still in
 * flight. While a household turn waits for a host of the workload, Core
 * answers `yield: true`: the request waits and asks again after
 * `retryAfterMs`. Once none of the workload's requests is in flight, Core
 * marks it yielded and serves the household turn; the next answer without
 * `yield` lets the request go.
 *
 * The passes of one workload are serialized, and a request counts as in
 * flight from the moment it leaves the yield point, so the count Core sees is
 * exact. The yield point never blocks evaluation on its own failure: an older
 * Core without the route (404), an inactive admission (409) or an error lets
 * the request go, and Core's admission still decides.
 */

const logger = require('../../../config/logger');
const coreApiClient = require('../../clients/coreApiClient');
const { CORE_OPERATIONS } = require('../../clients/coreOperations');

const DEFAULT_RETRY_MS = 2000;
const states = new Map();

function stateFor(workloadId) {
    if (!states.has(workloadId)) states.set(workloadId, { inFlight: 0, gate: Promise.resolve(), waitedMs: 0 });
    return states.get(workloadId);
}

function abortError(signal) {
    return signal.reason instanceof Error ? signal.reason : new Error('Benchmark inference cancelled while yielding');
}

function sleep(ms, signal) {
    if (signal?.aborted) return Promise.reject(abortError(signal));
    return new Promise((resolve, reject) => {
        const onAbort = () => { clearTimeout(timer); reject(abortError(signal)); };
        const timer = setTimeout(() => { signal?.removeEventListener?.('abort', onAbort); resolve(); }, ms);
        signal?.addEventListener?.('abort', onAbort, { once: true });
    });
}

function admissionProof(workloadId) {
    try {
        return coreApiClient.getWorkloadAdmissionIdentity(workloadId);
    } catch {
        return null;
    }
}

async function askYieldPoint(workloadId, proof, inFlight) {
    try {
        const data = await coreApiClient.coreRequest(
            `/api/nerve-center/workload-admissions/${encodeURIComponent(proof.workloadAdmissionId)}/yield-point`,
            {
                method: 'POST',
                operationId: CORE_OPERATIONS.WORKLOAD_YIELD_POINT,
                body: JSON.stringify({ generation: proof.workloadGeneration, inFlight })
            }
        );
        return data?.data || { yield: false };
    } catch (error) {
        logger.debug('Yield point unavailable; the request goes on', { workloadId, error: error.message });
        return { yield: false };
    }
}

/**
 * Pass the yield point, then count the request as in flight. Call it before
 * starting the request's own timers, and call `release()` once the request
 * has settled. `yielded` says whether the workload gave its hosts to a
 * household turn while this request waited: a model may have been unloaded.
 */
async function enterInference(workloadId, { signal = null } = {}) {
    const key = workloadId ? String(workloadId) : '';
    const proof = key ? admissionProof(key) : null;
    if (!proof?.workloadAdmissionId) return { yielded: false, release: () => {} };
    const state = stateFor(key);
    const previous = state.gate;
    let open;
    state.gate = new Promise(resolve => { open = resolve; });
    try {
        await previous;
        let yielded = false;
        let waitStarted = null;
        for (;;) {
            if (signal?.aborted) throw abortError(signal);
            const answer = await askYieldPoint(key, proof, state.inFlight);
            if (answer.yield !== true) break;
            if (answer.yielded === true) yielded = true;
            if (waitStarted === null) {
                waitStarted = Date.now();
                logger.info('Benchmark workload waits for a household turn', { workloadId: key, inFlight: state.inFlight });
            }
            await sleep(Number(answer.retryAfterMs) > 0 ? Number(answer.retryAfterMs) : DEFAULT_RETRY_MS, signal);
        }
        if (waitStarted !== null) {
            state.waitedMs += Date.now() - waitStarted;
            logger.info('Benchmark workload resumes after a household turn', { workloadId: key, yielded, waitedMs: Date.now() - waitStarted });
        }
        state.inFlight += 1;
        let released = false;
        return {
            yielded,
            release: () => {
                if (released) return;
                released = true;
                state.inFlight -= 1;
            }
        };
    } finally {
        open();
    }
}

/** Run `request` between the yield point and its release. */
async function withInference(workloadId, request, { signal = null } = {}) {
    const inference = await enterInference(workloadId, { signal });
    try {
        return await request(inference);
    } finally {
        inference.release();
    }
}

/**
 * One timed prompt of a batch: pass the yield point, rewarm the model if the
 * workload yielded (a household turn may have replaced it), then run the
 * prompt. The wait and the rewarm happen before the prompt's own timing. A
 * stop while waiting reads as a stopped prompt.
 */
async function runPromptAfterYield(workloadId, { rewarm, signal = null }, runPrompt) {
    try {
        return await withInference(workloadId, async ({ yielded }) => {
            if (yielded) await rewarm();
            return runPrompt();
        }, { signal });
    } catch (error) {
        if (signal?.aborted) return { infraError: false, stopped: true, cancelled: true };
        throw error;
    }
}

/** Time the workload spent waiting for household turns, for budgets that should not count it. */
function yieldWaitMs(workloadId) {
    return states.get(String(workloadId || ''))?.waitedMs || 0;
}

/** Drop a finished workload's local state. */
function forgetWorkload(workloadId) {
    states.delete(String(workloadId || ''));
}

module.exports = { enterInference, withInference, runPromptAfterYield, yieldWaitMs, forgetWorkload };
