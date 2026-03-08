const fetchImpl = typeof globalThis.fetch === 'function'
    ? globalThis.fetch.bind(globalThis)
    : require('node-fetch');

function benchmarkFetch(...args) {
    return fetchImpl(...args);
}

module.exports = {
    benchmarkFetch
};
