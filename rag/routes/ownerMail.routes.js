'use strict';

const { timingSafeEqual } = require('node:crypto');
const express = require('express');
const { getOwnerMailStore } = require('../src/services/ownerMailStore');

// /api/rag/owner-mail: the owner's private recall corpus. Only Core holds the
// token; without one configured every call is refused. Core keeps provenance
// and decides what is indexed or forgotten; this route stores and searches.
const router = express.Router();
const DOCUMENT_ID = /^[a-z][a-z-]{1,30}:[a-zA-Z0-9_-]{8,160}$/;
const fail = (res, status, code, error) => res.status(status).json({ ok: false, code, error });

router.use((req, res, next) => {
  const expected = Buffer.from(process.env.OWNER_MAIL_RAG_TOKEN || '');
  if (expected.length < 32) return fail(res, 503, 'OWNER_MAIL_RECALL_UNCONFIGURED', 'Owner recall is not configured');
  const given = Buffer.from(String(req.get('x-agentx-owner-mail-token') || ''));
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
    return fail(res, 403, 'OWNER_MAIL_RECALL_FORBIDDEN', 'Owner recall is reserved to Core');
  }
  res.set('Cache-Control', 'no-store');
  return next();
});

const handle = work => async (req, res) => {
  try { return res.json({ ok: true, ...(await work(req)) }); }
  catch (error) { return fail(res, error.statusCode || 500, error.code || 'OWNER_MAIL_RECALL_FAILED', error.message); }
};
const invalid = message => Object.assign(new Error(message), { statusCode: 400, code: 'OWNER_MAIL_RECALL_INVALID' });

router.post('/documents', handle(async req => {
  const documents = req.body?.documents;
  if (!Array.isArray(documents) || !documents.length || documents.length > 50) throw invalid('Index 1-50 documents');
  for (const doc of documents) {
    if (!DOCUMENT_ID.test(doc?.documentId || '') || typeof doc.text !== 'string' || !doc.text.trim() || doc.text.length > 200000) {
      throw invalid('Each document needs an owner recall id and 1-200000 characters of text');
    }
  }
  const store = getOwnerMailStore();
  const results = [];
  for (const doc of documents) {
    const stored = await store.upsertDocumentWithChunks(doc.text, { documentId: doc.documentId, source: `owner-recall:${doc.documentId}`,
      tags: [doc.documentId.split(':')[0]], scope: 'owner', sensitivity: 'private', forceReindex: doc.forceReindex === true });
    results.push({ documentId: doc.documentId, chunkCount: stored?.chunkCount ?? null, unchanged: stored?.unchanged === true });
  }
  return { results };
}));

router.post('/search', handle(async req => {
  const query = typeof req.body?.query === 'string' ? req.body.query.trim() : '';
  if (!query || query.length > 2000) throw invalid('A query of 1-2000 characters is required');
  const topK = Math.max(1, Math.min(20, Math.trunc(Number(req.body.topK)) || 8));
  const minScore = Number.isFinite(Number(req.body.minScore)) ? Math.max(0, Math.min(1, Number(req.body.minScore))) : undefined;
  const { results } = await getOwnerMailStore().search(query, { topK, ...(minScore === undefined ? {} : { minScore }) });
  return { results: results.map(row => ({ documentId: row.metadata?.documentId, chunkIndex: row.metadata?.chunkIndex ?? row.chunkIndex ?? 0,
    text: row.text, score: row.score })) };
}));

router.delete('/documents/:documentId', handle(async req => {
  if (!DOCUMENT_ID.test(req.params.documentId)) throw invalid('Choose an owner recall id');
  await getOwnerMailStore().deleteDocument(req.params.documentId);
  return { documentId: req.params.documentId, deleted: true };
}));

router.get('/stats', handle(async () => {
  const stats = await getOwnerMailStore().getStats();
  return { documentCount: stats.documentCount ?? null, chunkCount: stats.chunkCount ?? null };
}));

module.exports = router;
