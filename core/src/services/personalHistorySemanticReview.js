'use strict';
const Review = require('../../models/PersonalHistorySemanticReview');
const original = require('./personalHistoryManifestConfirmationContract');
const current = require('./personalHistoryManifestConfirmationCurrent');
const evidence = require('./personalHistorySemanticReviewEvidence');
const c = require('./personalHistorySemanticReviewContract');
const { digest } = require('./personalHistorySourceReviewSources');

async function load(requestId) {
  const row = await Review.findById(original.identity(requestId)).lean();
  if (!row) throw c.error('UNKNOWN', 404);
  return row;
}
async function get(requestId, deps) {
  original.owner(deps); return c.view(await load(requestId), requestId);
}
async function update(row, fields) {
  try {
    return await Review.findOneAndUpdate({ _id: row._id, state: row.state, version: row.version },
      { $set: fields, $inc: { version: 1 } }, { new: true, runValidators: true }).lean() || await Review.findById(row._id).lean();
  } catch { return Review.findById(row._id).lean(); }
}
async function blocked(row, requestId, error) {
  const blockedCode = error.statusCode === 413 ? 'evidence_capacity'
    : error.statusCode === 409 ? 'evidence_changed' : 'evidence_unavailable';
  return c.view(await update(row, { state: 'blocked', blockedCode }), requestId, { replayed: false });
}
async function prepare(manifestRequestId, value, deps) {
  const selected = c.parse(manifestRequestId, value, 'prepare', deps), requestId = value.requestId;
  let row;
  try { row = (await Review.create({ _id: original.identity(requestId), inputSha256: digest(selected), state: 'preparing' })).toObject(); }
  catch { return c.view(c.originalScope(await load(requestId), selected), requestId); }
  let observed;
  try { observed = await evidence.observe(selected, deps); }
  catch (error) { return blocked(row, requestId, error); }
  const sources = observed.sources.map(source => ({ resources: source.resources.map(r => ({ ...r, nextOffset: 0, served: false })) }));
  const saved = await update(row, { state: 'prepared', bindingSha256: observed.bindingSha256, sources, preparedAt: new Date() });
  const shown = saved.state === 'prepared' && saved.bindingSha256 === observed.bindingSha256;
  if (shown) await current.assertEvidenceCurrent(observed, deps);
  return c.view(saved, requestId, { replayed: false, ...(shown ? { preview: evidence.preview(observed, saved) } : {}) });
}
async function observeOriginal(row, selected, deps, read) {
  const observed = await evidence.observe(selected, deps, read);
  if (observed.bindingSha256 !== row.bindingSha256
    || !evidence.same(evidence.descriptors(row.sources), evidence.descriptors(observed.sources))) throw c.error('EVIDENCE_CHANGED');
  return observed;
}
async function reopen(requestId, value, deps) {
  const selected = c.parse(requestId, value, 'reopen', deps), row = c.originalScope(await load(requestId), selected);
  if (row.state !== 'prepared') return c.view(row, requestId);
  const observed = await observeOriginal(row, selected, deps);
  const retained = c.originalScope(await load(requestId), selected);
  const shown = retained.state === 'prepared' && retained.bindingSha256 === row.bindingSha256;
  if (shown) await current.assertEvidenceCurrent(observed, deps);
  return c.view(retained, requestId, { ...(shown ? { preview: evidence.preview(observed, retained) } : {}) });
}
async function read(requestId, value, deps) {
  const selected = c.parse(requestId, value, 'read', deps), row = c.originalScope(await load(requestId), selected);
  if (row.state !== 'prepared') throw c.error('NOT_PREPARED');
  const r = row.sources[value.source]?.resources[value.resource];
  // Already served offsets can be reread after an uncertain page response.
  // A caller cannot skip bytes, submit a progress attestation or choose a path.
  if (!r || value.offset > r.nextOffset || value.offset > r.bytes) throw c.error('OFFSET_INVALID', 400);
  const observed = await observeOriginal(row, selected, deps, value);
  const sources = row.sources.map(source => ({ resources: source.resources.map(r => ({ ...r })) }));
  const progress = sources[value.source].resources[value.resource];
  progress.nextOffset = Math.max(progress.nextOffset, observed.page.nextOffset ?? progress.bytes);
  progress.served = progress.nextOffset === progress.bytes;
  const saved = await update(row, { sources });
  if (!saved || saved.state !== 'prepared' || saved.bindingSha256 !== row.bindingSha256
    || saved.sources[value.source].resources[value.resource].nextOffset < progress.nextOffset) throw c.error('PROGRESS_CHANGED');
  await current.assertEvidenceCurrent(observed, deps);
  return { receipt: c.view(saved, requestId, { replayed: false, preview: evidence.preview(observed, saved) }), page: observed.page };
}
async function decide(requestId, value, deps) {
  const selected = c.parse(requestId, value, 'decide', deps), row = c.originalScope(await load(requestId), selected);
  if (value.bindingSha256 !== row.bindingSha256 || (row.decision && row.decision !== value.decision)) throw c.error('DECISION_CHANGED');
  if (row.state !== 'prepared') return c.view(row, requestId);
  if (value.decision === 'accepted_selected_semantics' && !c.coverage(row).complete) throw c.error('READING_INCOMPLETE');
  let reserved;
  try {
    reserved = await Review.findOneAndUpdate({ _id: row._id, state: 'prepared', version: row.version },
      { $set: { state: 'deciding', decision: value.decision }, $inc: { version: 1 } }, { new: true, runValidators: true }).lean();
  } catch { /* An uncertain reservation is observed, never taken over. */ }
  if (!reserved) return c.view(await load(requestId), requestId);
  let observed;
  try {
    observed = await observeOriginal(reserved, selected, deps);
    if (value.decision === 'accepted_selected_semantics' && observed.blockers.length) throw c.error('AMBIGUOUS');
  } catch (error) { return blocked(reserved, requestId, error); }
  const saved = await update(reserved, { state: value.decision === 'accepted_selected_semantics' ? 'accepted' : 'held', decidedAt: new Date() });
  // No private bytes in a decision acknowledgement. The receipt remains
  // historical; only a new native observation can assert current acceptance.
  return c.view(saved, requestId, { replayed: false });
}
function safe(action) {
  return async (...args) => {
    try { return await action(...args); }
    catch (error) {
      if (typeof error.code === 'string' && error.code.startsWith('HISTORY_SEMANTIC_REVIEW_')) throw error;
      if ([400, 403, 404, 409, 413].includes(error.statusCode)) throw c.error('SCOPE', error.statusCode);
      throw c.error('UNAVAILABLE', 503);
    }
  };
}
module.exports = { prepare: safe(prepare), get: safe(get), reopen: safe(reopen), read: safe(read), decide: safe(decide), load, observeOriginal };
