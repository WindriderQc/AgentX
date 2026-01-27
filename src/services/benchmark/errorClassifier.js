/**
 * Benchmark Error Classifier
 *
 * Distinguishes infra/network/runtime failures from model/response failures.
 * Used to prevent infrastructure noise from impacting model reliability ranking.
 */

function _normalizeMessage(message) {
    if (!message) return '';
    return String(message).trim();
}

function classifyBenchmarkError(errorLike) {
    const message = _normalizeMessage(
        typeof errorLike === 'string'
            ? errorLike
            : (errorLike && (errorLike.message || errorLike.error))
    );

    const upper = message.toUpperCase();

    // Network / DNS / socket
    const infraPatterns = [
        'ECONNREFUSED',
        'ECONNRESET',
        'EPIPE',
        'ENOTFOUND',
        'EAI_AGAIN',
        'ETIMEDOUT',
        'ESOCKETTIMEDOUT',
        'CERT_',
        'TLS',
        'SSL',
        'SOCKET HANG UP',
        'FETCH FAILED',
        'NETWORK',
        'CONNECTION',
        'CONNECT '
    ];

    const isHttpError = /^HTTP\s+\d+\s*:/i.test(message);
    let httpStatus = null;
    if (isHttpError) {
        const m = message.match(/^HTTP\s+(\d+)\s*:/i);
        if (m) httpStatus = Number(m[1]);
    }

    const infraByHttp = Number.isFinite(httpStatus) && (httpStatus >= 500 || httpStatus === 429 || httpStatus === 408);

    const infraByPattern = infraPatterns.some(p => upper.includes(p));

    // Abort/timeout wording seen across fetch/undici/node-fetch
    const infraByWording = /timed?\s*out|timeout|aborted|aborterror/i.test(message);

    const infra = !!(infraByHttp || infraByPattern || infraByWording);

    return {
        infra,
        type: infra ? 'infra' : (message ? 'model' : 'unknown'),
        httpStatus: Number.isFinite(httpStatus) ? httpStatus : null,
        message
    };
}

module.exports = {
    classifyBenchmarkError
};
