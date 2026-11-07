'use strict';

const { createHash } = require('node:crypto');
// A faithful in-memory RAG boundary: reads expose a revision fingerprint, and
// validity writes refuse a changed document exactly like the RAG service.
function fakeRag(hits = []) {
  const docs = new Map(), calls = [];
  const notFound = () => Object.assign(new Error('RAG returned 404: Document not found'), { status: 404 });
  const fingerprint = ({ replacementWrite: _proof, ...doc }) => createHash('sha256').update(JSON.stringify(doc)).digest('hex');
  const conflict = () => Object.assign(new Error('The replacement changed or proof is missing; reconcile before any retry'), { statusCode: 409 });
  const unchanged = (doc, key) => Boolean(typeof key === 'string' && doc?.replacementWrite?.key === key && doc.replacementWrite.fingerprint === fingerprint(doc));
  const document = (text, m) => ({ documentId: m.documentId, source: m.source, text, metadata: { scope: m.scope, sensitivity: m.sensitivity,
    validFrom: m.validFrom || null, sourceRefs: m.sourceRefs || [], invalidatedAt: null, supersededBy: null } });
  const view = doc => ({ documentId: doc.documentId, source: doc.source,
    metadata: { ...doc.metadata, revisionFingerprint: fingerprint(doc), replacementWrite: doc.replacementWrite || null,
      replacementUnchanged: unchanged(doc, doc.replacementWrite?.key) } });
  return { docs, calls,
    seed(documentId, text, metadata, source = 'nestor-memory') {
      docs.set(documentId, { documentId, source, text, metadata: { scope: 'owner', sensitivity: 'private', validFrom: null,
        sourceRefs: [], invalidatedAt: null, supersededBy: null, ...metadata } });
    },
    async getDocument(id) { calls.push(['get', id]); const doc = docs.get(id); if (!doc) throw notFound(); return view(doc); },
    async getDocumentChunks(id) { const doc = docs.get(id); if (!doc) throw notFound(); return { documentId: id, chunks: [{ chunkIndex: 0, text: doc.text }] }; },
    async upsertDocumentWithChunks(text, m) {
      calls.push(['upsert', m.documentId]);
      docs.set(m.documentId, { ...document(text, m), ...(m.replacementWrite ? { replacementWrite: m.replacementWrite } : {}) });
      return { documentId: m.documentId, status: 'created' };
    },
    async setDocumentValidity(id, { invalidatedAt, supersededBy, expectedFingerprint }) {
      calls.push(['validity', id, supersededBy]);
      const doc = docs.get(id); if (!doc) throw notFound();
      if (fingerprint(doc) !== expectedFingerprint) throw Object.assign(new Error('RAG returned 409: The document changed after review'), { status: 409 });
      doc.metadata = { ...doc.metadata, invalidatedAt, supersededBy };
      return { documentId: id };
    },
    async createReplacementDocument(id, { text, key, ...m }) {
      const existing = docs.get(id);
      if (existing) {
        if (!unchanged(existing, key) || fingerprint(existing) !== fingerprint(document(text, { ...m, documentId: id }))) throw conflict();
        return { documentId: id, status: 'unchanged' };
      }
      const initial = document(text, { ...m, documentId: id });
      return this.upsertDocumentWithChunks(text, { ...m, documentId: id, replacementWrite: { key, fingerprint: fingerprint(initial) } });
    },
    async deleteReplacementDocument(id, key) {
      calls.push(['delete', id]);
      const doc = docs.get(id);
      if (!doc) return { documentId: id, status: 'absent' };
      if (!unchanged(doc, key)) throw conflict();
      docs.delete(id);
      return { documentId: id };
    },
    async searchSimilarChunks() { return hits; },
  };
}

module.exports = { fakeRag };
