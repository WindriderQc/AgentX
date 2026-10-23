'use strict';

jest.mock('../../src/services/ragStore', () => ({ getRagStore: () => ({
  getDocument: async () => ({ documentId: 'synthetic', source: 'agent-artifacts',
    scope: 'owner', sensitivity: 'private',
    validFrom: '2026-01-05T00:00:00.000Z', recordedAt: '2026-01-20T00:00:00.000Z',
    sourceRefs: [{ system: 'memory-review', id: 'run:candidate' }] }),
  getDocumentChunks: async () => [{ chunkIndex: 0, text: 'Synthetic late-reported fact' }],
}) }));

const express = require('express');
const request = require('supertest');
const app = express();
app.use('/api/rag', require('../../routes/document.routes'));

test.each(['', '/chunks'])('document read %s exposes the source fact date separately from recording time', async suffix => {
  const res = await request(app).get(`/api/rag/documents/synthetic${suffix}`).expect(200);
  const metadata = suffix ? res.body.data.chunks[0].metadata : res.body.data.metadata;
  expect(metadata).toMatchObject({
    validFrom: '2026-01-05T00:00:00.000Z', recordedAt: '2026-01-20T00:00:00.000Z',
    sourceRefs: [{ system: 'memory-review', id: 'run:candidate' }], scope: 'owner', sensitivity: 'private',
  });
});
