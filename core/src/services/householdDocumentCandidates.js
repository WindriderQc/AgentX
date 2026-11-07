'use strict';
const Candidate = require('../../models/HouseholdDocumentCandidate');
const { createDocumentArchive, fingerprint, fail } = require('./householdDocumentArchive');
const { sha256 } = require('../helpers/fileContentChecks');
const { getRagServiceClient } = require('./ragServiceClient');
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const WC = { w: 1, j: true };
function createDocumentCandidates({ archive = createDocumentArchive(), rag = getRagServiceClient(),
  targetSource = () => null, now = () => new Date(), model = Candidate } = {}) {
  let indexes;
  const ready = () => indexes ||= model.createIndexes().catch(error => { indexes = null; throw error; });
  function eligibility(row) {
    const dates = [row.origin.expiresAt, row.origin.invalidatedAt].filter(Boolean);
    if (dates.some(date => new Date(date) <= now()) || row.origin.supersededBy) return 'expired_or_superseded';
    return null;
  }
  function projection(row, detail = false) {
    return { id: row._id, sourceId: row.sourceId, title: row.origin.title, revision: row.revision, state: row.state,
      scope: row.origin.scope, sensitivity: row.origin.sensitivity, expiresAt: row.origin.expiresAt,
      validFrom: row.origin.validFrom, invalidatedAt: row.origin.invalidatedAt, supersededBy: row.origin.supersededBy,
      sourceRefs: row.origin.sourceRefs, tags: row.origin.tags, sha256: row.origin.sha256,
      archiveId: row.origin.archiveId, size: row.origin.size,
      blockedReason: eligibility(row), selection: row.selection || null,
      requestId: row.requestId || null, target: row.target || null, receipt: row.receipt || null,
      failure: row.failure || null,
      ...(detail ? { text: row.text, original: { root: row.origin.root, relativePath: row.origin.relativePath } } : {}) };
  }
  async function load(id, revision) {
    if (!/^[a-f0-9]{64}$/.test(id || '')) throw fail('Candidat invalide.');
    const row = await model.findById(id).lean();
    if (!row) throw fail('Candidat introuvable.', 404);
    if (revision !== undefined && row.revision !== revision) throw fail('La révision consultée a changé.', 409);
    return row;
  }
  async function fresh(row) {
    const current = await archive.read(row.sourceId);
    if (current.revision !== row.revision) throw fail('L’original ou ses métadonnées ont changé. Préparez un nouveau candidat.', 409, 'HOUSEHOLD_DOCUMENT_CHANGED');
    if (eligibility(row)) throw fail('Document périmé ou remplacé : promotion refusée.', 409, 'HOUSEHOLD_DOCUMENT_EXPIRED');
  }
  async function stage({ sourceId } = {}) {
    const current = await archive.read(sourceId);
    await ready();
    const id = fingerprint({ sourceId, revision: current.revision });
    const row = await model.findOneAndUpdate({ _id: id }, { $setOnInsert: {
      sourceId, ...current, state: 'staged'
    } }, { upsert: true, new: true, writeConcern: WC }).lean();
    return projection(row, true);
  }
  async function list({ offset = 0 } = {}) {
    const page = Number(offset);
    if (!Number.isInteger(page) || page < 0 || page > 100000) throw fail('Page invalide.');
    const rows = await model.find({}).sort({ createdAt: -1, _id: 1 }).skip(page).limit(21).lean();
    return { entries: rows.slice(0, 20).map(row => projection(row)), nextOffset: rows.length > 20 ? page + 20 : null,
      identityVerified: false, accessContract: 'private_lan_explicit_human_review' };
  }
  async function review(id, { expectedRevision, decision, reviewer } = {}) {
    if (typeof expectedRevision !== 'string' || !/^[a-f0-9]{64}$/.test(expectedRevision) || !['select', 'dismiss'].includes(decision)
      || typeof reviewer !== 'string' || !reviewer.trim() || reviewer.length > 80) throw fail('Révision, décision et nom déclaré requis.');
    const row = await load(id, expectedRevision);
    let target = null;
    if (decision === 'select') {
      await fresh(row);
      target = await targetSource();
      if (!target) throw fail('Le corpus familial existant n’est pas actif ou configuré.', 409, 'HOUSEHOLD_DOCUMENT_TARGET_DISABLED');
    }
    const state = decision === 'select' ? 'selected' : 'dismissed';
    if (!['staged', 'selected', 'dismissed'].includes(row.state)) throw fail('La promotion est déjà engagée. Réconciliez son résultat.', 409);
    const updated = await model.findOneAndUpdate({ _id: id, state: row.state,
      selection: row.selection || { $exists: false } }, { $set: { state,
      selection: { reviewer: reviewer.trim(), identityVerified: false, decision, at: now().toISOString(), revision: row.revision, target }
    } }, { new: true, writeConcern: WC }).lean();
    if (!updated) throw fail('Décision concurrente. Actualisez le candidat.', 409);
    return projection(updated, true);
  }
  async function observed(row) {
    let doc;
    try { doc = await rag.getDocument(row.target.documentId); }
    catch (error) { if (error.status === 404 || error.statusCode === 404) return null; throw error; }
    const m = doc?.metadata;
    if (!m || doc.documentId !== row.target.documentId || doc.source !== row.target.source
      || m.contentHash !== sha256(Buffer.from(row.text)) || m.mixedRevision !== false
      || !Number.isInteger(doc.chunkCount) || doc.chunkCount < 1 || !/^[a-f0-9]{64}$/.test(m.revisionFingerprint || '')
      || m.scope !== 'household' || m.sensitivity !== 'normal' || m.validFrom !== row.target.validFrom
      || m.invalidatedAt !== row.target.invalidatedAt || m.supersededBy
      || JSON.stringify(m.sourceRefs) !== JSON.stringify(row.target.sourceRefs)
      || JSON.stringify(m.tags) !== JSON.stringify(row.target.tags)) return null;
    return { documentId: doc.documentId, source: doc.source, chunkCount: doc.chunkCount,
      contentHash: m.contentHash, revisionFingerprint: m.revisionFingerprint, observedAt: now().toISOString() };
  }
  async function reconcile(row) {
    let receipt;
    try { receipt = await observed(row); } catch { /* An unavailable read never authorizes another write. */ }
    if (!receipt) {
      await model.updateOne({ _id: row._id, requestId: row.requestId, state: { $in: ['dispatching', 'uncertain'] } },
        { $set: { state: 'uncertain', failure: 'RAG_RESULT_UNCONFIRMED' } }, { writeConcern: WC });
      return projection(await load(row._id), true);
    }
    await model.updateOne({ _id: row._id, requestId: row.requestId, state: { $in: ['dispatching', 'uncertain'] } },
      { $set: { state: 'promoted', receipt }, $unset: { failure: 1 } }, { writeConcern: WC });
    return projection(await load(row._id), true);
  }
  async function promote(id, { expectedRevision, requestId, confirmation } = {}) {
    if (typeof requestId !== 'string' || !UUID.test(requestId) || typeof expectedRevision !== 'string' || !/^[a-f0-9]{64}$/.test(expectedRevision)
      || confirmation !== `SHARE ${id}`) throw fail('Confirmez explicitement le partage du document entier avec la famille.');
    let row = await load(id, expectedRevision);
    if (row.requestId) {
      if (row.requestId !== requestId) throw fail('Conservez l’identifiant de la promotion existante.', 409);
      return row.state === 'promoted' ? projection(row, true) : reconcile(row);
    }
    if (row.state !== 'selected' || row.selection?.revision !== row.revision) throw fail('Sélection humaine explicite requise.', 409);
    await fresh(row);
    const approved = await targetSource();
    if (!approved || fingerprint(approved) !== fingerprint(row.selection.target)) throw fail('Le corpus familial a changé. Sélectionnez à nouveau le candidat.', 409, 'HOUSEHOLD_DOCUMENT_TARGET_CHANGED');
    const invalidatedAt = [row.origin.invalidatedAt, row.origin.expiresAt].filter(Boolean).sort()[0] || null;
    const target = { documentId: `household-approved-${id}`, source: approved.source, scope: 'household', sensitivity: 'normal',
      validFrom: row.origin.validFrom, invalidatedAt, supersededBy: null,
      // Private archive paths and references remain in Core. The derivative
      // has an opaque link back to its exact, retained review record.
      sourceRefs: [{ system: 'household-review', id }], tags: row.origin.tags };
    // Refuse a collision before recording dispatch. Never overwrite a foreign
    // or independently edited document, even if it has identical content.
    try {
      if (await rag.getDocument(target.documentId)) throw fail('La cible existe déjà. Réconciliation manuelle requise.', 409);
    } catch (error) { if (error.status !== 404 && error.statusCode !== 404) throw error; }
    await ready();
    try {
      row = await model.findOneAndUpdate({ _id: id, state: 'selected', requestId: { $exists: false },
        selection: row.selection }, { $set: { requestId, target, state: 'dispatching' } }, { new: true, writeConcern: WC }).lean();
    } catch (error) { if (error.code === 11000) throw fail('Identifiant de requête déjà utilisé.', 409); throw error; }
    if (!row) throw fail('La sélection a changé. Actualisez le candidat.', 409);
    // One outbound attempt for this durable identity. A timeout, crash or lost
    // response keeps the fence; reconciliation only reads the original ID.
    try { await rag.upsertDocumentWithChunks(row.text, target); }
    catch { /* Read the exact native result, never repeat an uncertain launch. */ }
    return reconcile(row);
  }
  return { sources: options => archive.list(options), stage, list, review, promote,
    get: async id => projection(await load(id), true) };
}
module.exports = { createDocumentCandidates };
