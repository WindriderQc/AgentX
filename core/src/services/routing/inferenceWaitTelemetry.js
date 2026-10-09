'use strict';

/**
 * Waits an inference spends before Ollama receives it, recorded on its
 * inferencelogs row (#363): runtime admission, the host gate, and the retries
 * of one logical call (attempt, cause, backoff, and the waits of each failed
 * attempt). Counts, codes and durations only; bounded.
 */

const MAX_RETRY_HISTORY = 6;
// Causes are server codes (`workload_reserved`, `ECONNRESET`); anything else is `other`.
const CAUSE_PATTERN = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;

function waitMs(value) {
    const number = Number(value);
    return value != null && Number.isFinite(number) && number >= 0 ? Math.round(number) : undefined;
}

/** The measured waits of one attempt; an unmeasured wait stays absent. */
function attemptWaits(waits) {
    const admissionMs = waitMs(waits?.admissionMs);
    const hostGateMs = waitMs(waits?.hostGateMs);
    return {
        ...(admissionMs !== undefined && { admissionMs }),
        ...(hostGateMs !== undefined && { hostGateMs }),
    };
}

function sanitizeRetry(retry) {
    if (!retry || typeof retry !== 'object' || !Array.isArray(retry.history) || retry.history.length === 0) return null;
    const history = retry.history.slice(0, MAX_RETRY_HISTORY).map((entry, index) => ({
        attempt: Number.isSafeInteger(entry?.attempt) && entry.attempt > 0 ? entry.attempt : index + 1,
        cause: CAUSE_PATTERN.test(String(entry?.cause || '')) ? entry.cause : 'other',
        delayMs: waitMs(entry?.delayMs) ?? 0,
        ...attemptWaits(entry),
    }));
    const attempts = Number.isSafeInteger(retry.attempts) && retry.attempts > 0
        ? Math.min(retry.attempts, 100)
        : history.length;
    return { attempts, delayMs: history.reduce((sum, entry) => sum + entry.delayMs, 0), history };
}

/** Row fields for the waits of the attempt that ended the call and its retries. */
function inferenceWaitFields({ waits, retry } = {}) {
    const { admissionMs, hostGateMs } = attemptWaits(waits);
    const sanitized = sanitizeRetry(retry);
    return {
        ...(admissionMs !== undefined && { admissionWaitMs: admissionMs }),
        ...(hostGateMs !== undefined && { hostGateWaitMs: hostGateMs }),
        ...(sanitized && { retry: sanitized }),
    };
}

module.exports = { MAX_RETRY_HISTORY, attemptWaits, inferenceWaitFields, sanitizeRetry };
