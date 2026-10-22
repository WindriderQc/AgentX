jest.mock('../../src/utils/fetchWithTimeout', () => jest.fn());

const fetch = require('../../src/utils/fetchWithTimeout');
const QdrantVectorStore = require('../../src/services/vectorStore/QdrantVectorStore');
const wellFormedJson = require('../../src/services/vectorStore/wellFormedJson');

const EMOJI = '\u{1F600}';
const LONE_HIGH = '\uD83D';
const LONE_LOW = '\uDE00';
// What JSON.stringify writes for a lone surrogate, and what Qdrant refuses.
const SURROGATE_ESCAPE = /\\u[dD][89abcdefABCDEF][0-9a-fA-F]{2}/;

function mockOk(jsonBody = {}) {
  return { ok: true, json: async () => jsonBody, text: async () => '' };
}

describe('wellFormedJson', () => {
  test('replaces lone surrogates and keeps whole pairs', () => {
    const body = wellFormedJson({ text: `a${LONE_HIGH}b${LONE_LOW}c${EMOJI}`, list: [LONE_LOW], n: 1 });
    expect(body).not.toMatch(SURROGATE_ESCAPE);
    expect(JSON.parse(body)).toEqual({ text: `a�b�c${EMOJI}`, list: ['�'], n: 1 });
  });
});

describe('QdrantVectorStore request bodies carry no lone surrogate', () => {
  let store;

  beforeEach(() => {
    fetch.mockReset();
    // Both the shared and owner collections use this writer; only the name differs.
    store = new QdrantVectorStore({ qdrantUrl: 'http://qdrant:6333', collectionName: 'owner-test' });
    store._collectionVerified = true;
  });

  test('upsert sends lone surrogates as U+FFFD and keeps emoji', async () => {
    fetch.mockResolvedValueOnce(mockOk({ result: { points: [] } })); // scroll for existing points
    fetch.mockResolvedValueOnce(mockOk()); // upsert batch
    fetch.mockResolvedValueOnce(mockOk()); // cleanup of other revisions

    await store.upsertDocument('doc-1', { source: 'mail', title: `Objet ${LONE_LOW}` }, [
      { chunkIndex: 0, text: `Salut ${EMOJI} fin${LONE_HIGH}`, embedding: [0.1, 0.2] },
      { chunkIndex: 1, text: `${LONE_LOW}suite`, embedding: [0.3, 0.4] }
    ]);

    const [url, options] = fetch.mock.calls[1];
    expect(url).toContain('/collections/owner-test/points');
    expect(options.method).toBe('PUT');
    expect(options.body).not.toMatch(SURROGATE_ESCAPE);
    const { points } = JSON.parse(options.body);
    expect(points[0].payload.text).toBe(`Salut ${EMOJI} fin�`);
    expect(points[0].payload.title).toBe('Objet �');
    expect(points[1].payload.text).toBe('�suite');
    expect(points[0].vector).toEqual([0.1, 0.2]);
  });

  test('original text payload is well formed', async () => {
    fetch.mockResolvedValueOnce(mockOk({ result: { points: [{ id: 'uuid-0', payload: { chunkIndex: 0 } }] } }));
    fetch.mockResolvedValueOnce(mockOk());

    await store.setDocumentOriginalText('doc-1', `corps ${EMOJI}${LONE_HIGH}`);

    const { body } = fetch.mock.calls[1][1];
    expect(body).not.toMatch(SURROGATE_ESCAPE);
    expect(JSON.parse(body).payload).toEqual({ originalText: `corps ${EMOJI}�` });
  });
});
