// Use the same transport as Core and our peer-verified outbound adapters.
// Native fetch adds independent 300-second header/body timeouts and ignores
// Node agents and the legacy timeout option. Long CPU generations must remain
// governed by the caller's AbortSignal/deadline, including body consumption.
const fetchImpl = require('node-fetch');

function benchmarkFetch(url, options = {}) {
    // Ollama endpoints are never allowed to redirect the Benchmark service to
    // another network target. Callers may add transport controls, but cannot
    // opt this boundary back out.
    return fetchImpl(url, { ...options, redirect: 'manual' });
}

module.exports = {
    benchmarkFetch
};
