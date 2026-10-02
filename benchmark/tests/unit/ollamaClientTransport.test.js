const http = require('node:http');

jest.mock('../../src/helpers/ollamaTargetAdmission', () => ({
    admitOllamaTargetResolved: async url => url
}));
jest.mock('../../src/helpers/ollamaHostConfig', () => ({ getConfiguredHosts: () => [] }));
jest.mock('../../config/logger', () => ({ debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const { ollamaFetch } = require('../../src/clients/ollamaClient');
const { destroyAgents } = require('../../src/helpers/httpAgent');

async function withServer(handler, run) {
    const timers = [];
    const later = (fn, ms) => timers.push(setTimeout(fn, ms));
    const server = http.createServer((req, res) => handler(req, res, later));
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    try { await run(`http://127.0.0.1:${server.address().port}`); }
    finally {
        timers.forEach(clearTimeout);
        destroyAgents();
        server.closeAllConnections();
        await new Promise(resolve => server.close(resolve));
    }
}

test('delayed headers use the configured transport, not native fetch', async () => {
    const native = jest.spyOn(global, 'fetch').mockRejectedValue(new Error('native transport used'));
    try {
        await withServer((_req, res, later) => later(() => res.end('{"ok":true}'), 40), async url => {
            await expect(ollamaFetch(url, '/api/tags', { timeoutMs: 2000 })).resolves.toEqual({ ok: true });
            expect(native).not.toHaveBeenCalled();
        });
    } finally { native.mockRestore(); }
});

test.each(['headers', 'body'])('deadline still bounds stalled %s', async phase => {
    await withServer((_req, res) => {
        if (phase === 'body') { res.writeHead(200, { 'Content-Type': 'application/json' }); res.write('{'); }
    }, async url => {
        await expect(ollamaFetch(url, '/api/tags', { timeoutMs: 100 })).rejects.toMatchObject({ code: 'ETIMEDOUT' });
    });
});

test('caller cancellation remains effective while reading a response body', async () => {
    const controller = new AbortController();
    const reason = new Error('operator cancelled');
    await withServer((_req, res, later) => {
        res.writeHead(200, { 'Content-Type': 'application/json' }); res.write('{');
        later(() => controller.abort(reason), 20);
    }, async url => {
        await expect(ollamaFetch(url, '/api/tags', { timeoutMs: 2000, signal: controller.signal })).rejects.toBe(reason);
    });
});

// The context probe reads this tag to keep "no answer from Ollama" apart from
// capacity evidence.
test.each(['headers', 'body'])('tags an expired deadline during %s as a transport failure', async phase => {
    await withServer((_req, res) => {
        if (phase === 'body') { res.writeHead(200, { 'Content-Type': 'application/json' }); res.write('{'); }
    }, async url => {
        await expect(ollamaFetch(url, '/api/generate', { timeoutMs: 100 }))
            .rejects.toMatchObject({ code: 'ETIMEDOUT', transportFailure: true });
    });
});

test('tags a refused connection as a transport failure', async () => {
    let closedUrl;
    await withServer(() => {}, async url => { closedUrl = url; });
    await expect(ollamaFetch(closedUrl, '/api/tags', { timeoutMs: 2000 }))
        .rejects.toMatchObject({ code: 'ECONNREFUSED', transportFailure: true });
});

test('does not tag an error answered by the runtime or a caller cancellation', async () => {
    await withServer((_req, res) => {
        res.statusCode = 500;
        res.end('{"error":"model requires more system memory"}');
    }, async url => {
        const error = await ollamaFetch(url, '/api/show', { timeoutMs: 2000 }).catch(err => err);
        expect(error.status).toBe(500);
        expect(error.transportFailure).toBeUndefined();
    });

    const controller = new AbortController();
    await withServer((_req, _res, later) => later(() => controller.abort(), 20), async url => {
        const error = await ollamaFetch(url, '/api/tags', { timeoutMs: 2000, signal: controller.signal }).catch(err => err);
        expect(error.code).toBe('CALLER_ABORTED');
        expect(error.transportFailure).toBeUndefined();
    });
});

// Optional real-wall-clock regression: no inference, only a loopback HTTP server.
const longTest = process.env.OLLAMA_CLIENT_LONG_HTTP_TEST === '1' ? test : test.skip;
longTest('receives headers after 300 seconds within a 420-second request budget', async () => {
    await withServer((_req, res, later) => later(() => res.end('{"done":true}'), 310000), async url => {
        await expect(ollamaFetch(url, '/api/generate', { timeoutMs: 420000 })).resolves.toEqual({ done: true });
    });
}, 440000);
