'use strict';

const http = require('node:http');
const { listenLoopback } = require('../../../../shared/testing/listenLoopback');

describe('Benchmark long-running HTTP transport', () => {
    const originalFetch = global.fetch;
    let server;
    let origin;
    let benchmarkFetch;
    let timers;

    beforeEach(async () => {
        jest.resetModules();
        // Native fetch's independent header/body deadlines must not replace
        // the operation deadline already owned by the Benchmark caller.
        global.fetch = jest.fn(() => Promise.reject(new Error('native header timeout')));
        ({ benchmarkFetch } = require('../../../src/services/benchmark/http'));
        timers = new Set();
    });

    afterEach(async () => {
        global.fetch = originalFetch;
        for (const timer of timers) clearTimeout(timer);
        if (server) {
            await new Promise(resolve => {
                server.close(resolve);
                server.closeAllConnections();
            });
        }
        server = null;
    });

    async function start(handler) {
        server = http.createServer(handler);
        const address = await listenLoopback(server);
        origin = `http://127.0.0.1:${address.port}`;
    }

    function later(callback, delayMs) {
        const timer = setTimeout(callback, delayMs);
        timers.add(timer);
    }

    test('waits for a non-streamed generation using the Node transport', async () => {
        await start((_req, res) => later(() => {
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({ done: true, response: 'complete' }));
        }, 80));
        const controller = new AbortController();
        later(() => controller.abort(), 2000);

        const response = await benchmarkFetch(`${origin}/api/inference/generate`, {
            method: 'POST', body: '{}', signal: controller.signal,
        });

        expect(await response.json()).toEqual({ done: true, response: 'complete' });
        expect(global.fetch).not.toHaveBeenCalled();
    });

    test('propagates a caller deadline while waiting for headers', async () => {
        const controller = new AbortController();
        await start((_req, _res) => later(() => controller.abort(), 20));

        await expect(benchmarkFetch(origin, { signal: controller.signal }))
            .rejects.toMatchObject({ name: 'AbortError' });
    });

    test('keeps cancellation active while reading a response body', async () => {
        await start((_req, res) => {
            res.setHeader('Content-Type', 'application/json');
            res.write('{"done":');
        });
        const controller = new AbortController();
        const response = await benchmarkFetch(origin, { signal: controller.signal });
        const body = response.json();
        controller.abort();

        await expect(body).rejects.toMatchObject({ name: 'AbortError' });
    });

    test('does not follow a redirect even when the caller requests it', async () => {
        let redirected = false;
        await start((req, res) => {
            if (req.url === '/redirected') redirected = true;
            res.writeHead(302, { Location: '/redirected' });
            res.end();
        });

        const response = await benchmarkFetch(origin, { redirect: 'follow' });

        expect(response.status).toBe(302);
        await response.text();
        expect(redirected).toBe(false);
    });
});
