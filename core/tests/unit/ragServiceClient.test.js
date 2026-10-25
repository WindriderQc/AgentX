'use strict';

jest.mock('node-fetch', () => jest.fn());
const fetch = require('node-fetch');
const { RagServiceClient } = require('../../src/services/ragServiceClient');

afterEach(() => { jest.useRealTimers(); jest.resetAllMocks(); });

test('memory classification survives the Core-to-RAG HTTP boundary', async () => {
  fetch.mockResolvedValue({ ok: true, text: async () => JSON.stringify({ ok: true, data: {} }) });
  await new RagServiceClient().upsertDocumentWithChunks('Synthetic private note', {
    source: 'nestor-memory', scope: 'private_domain', sensitivity: 'highly_private',
    validFrom: '2026-01-05T00:00:00Z', sourceRefs: [{ system: 'memory-review', id: 'run:candidate' }],
  });
  expect(JSON.parse(fetch.mock.calls[0][1].body)).toMatchObject({
    scope: 'private_domain', sensitivity: 'highly_private',
    validFrom: '2026-01-05T00:00:00Z', sourceRefs: [{ system: 'memory-review', id: 'run:candidate' }],
  });
});

test('typed metrics returns the owner data unchanged in one bounded request', async () => {
  const data = { totals: { documents: 351, chunks: 1053 }, bySource: [], lastIngest: null };
  fetch.mockResolvedValue({ ok: true, text: async () => JSON.stringify({ ok: true, data }) });
  expect(await new RagServiceClient().getMetrics()).toEqual(data);
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(fetch).toHaveBeenCalledWith(expect.stringMatching(/\/api\/rag\/metrics$/),
    expect.objectContaining({ method: 'GET', timeout: 5000 }));
});

test('typed metrics rejects a malformed success instead of synthesizing a corpus', async () => {
  fetch.mockResolvedValue({ ok: true, text: async () => JSON.stringify({ ok: true, data: {} }) });
  await expect(new RagServiceClient().getMetrics()).rejects.toMatchObject({ status: 502 });
});

test('an unavailable metrics request aborts at its deadline without another upstream call', async () => {
  jest.useFakeTimers();
  fetch.mockImplementation((_url, { signal }) => new Promise((_resolve, reject) => {
    signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
  }));
  const outcome = new RagServiceClient().getMetrics().catch(error => error);
  await jest.advanceTimersByTimeAsync(5001);
  expect(await outcome).toMatchObject({ status: 504, code: 'RAG_SERVICE_ERROR_TIMEOUT' });
  expect(fetch).toHaveBeenCalledTimes(1);
});

test('replacement validity and history requests cross the Core-to-RAG boundary unchanged', async () => {
  fetch.mockResolvedValue({ ok: true, text: async () => JSON.stringify({ ok: true, data: { results: [] } }) });
  const client = new RagServiceClient();
  await client.upsertDocumentWithChunks('Synthetic old fact', { documentId: 'old', scope: 'owner', sensitivity: 'private',
    invalidatedAt: '2026-03-01T00:00:00.000Z', supersededBy: 'new' });
  expect(JSON.parse(fetch.mock.calls[0][1].body)).toMatchObject({ invalidatedAt: '2026-03-01T00:00:00.000Z', supersededBy: 'new' });
  await client.searchSimilarChunks('Synthetic', { includeHistory: true });
  expect(JSON.parse(fetch.mock.calls[1][1].body).includeHistory).toBe(true);
  await client.searchSimilarChunks('Synthetic', {});
  expect(JSON.parse(fetch.mock.calls[2][1].body).includeHistory).toBeUndefined();
});
