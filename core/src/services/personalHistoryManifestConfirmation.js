'use strict';

const Confirmation = require('../../models/PersonalHistoryManifestConfirmation');
const evidence = require('./personalHistoryManifestConfirmationEvidence');
const contract = require('./personalHistoryManifestConfirmationContract');
const { digest, failure } = require('./personalHistorySourceReviewSources');

async function load(requestId) {
  const row = await Confirmation.findById(contract.identity(requestId)).lean();
  if (!row) throw failure('The original confirmation identity is not observed; its outcome remains unknown.',
    404, 'HISTORY_MANIFEST_CONFIRMATION_UNKNOWN');
  return row;
}

function original(row, selected) {
  if (row.inputSha256 !== digest(selected)) throw contract.changed();
  return row;
}

async function get(requestId, deps) {
  contract.owner(deps);
  return contract.view(await load(requestId), requestId);
}

async function blocked(row, requestId, error) {
  const blockedCode = error.statusCode === 413 ? 'evidence_capacity'
    : error.statusCode === 409 ? 'evidence_changed' : 'evidence_unavailable';
  try {
    const saved = await Confirmation.findOneAndUpdate({ _id: row._id, state: row.state },
      { $set: { state: 'blocked', blockedCode } }, { new: true, runValidators: true }).lean();
    if (saved) return contract.view(saved, requestId, { replayed: false });
  } catch { /* Reconcile an uncertain write by the original identity only. */ }
  return contract.view(await load(requestId), requestId);
}

async function prepare(value, deps) {
  contract.owner(deps);
  const requestId = value?.requestId, selected = contract.input(value, requestId, 'prepare');
  let row;
  try {
    row = (await Confirmation.create({ _id: contract.identity(requestId), inputSha256: digest(selected), state: 'preparing' })).toObject();
  } catch (error) {
    // A duplicate or a lost insert acknowledgement proves no ownership of the
    // native launch. Observe the original; never launch on an uncertain claim.
    const existing = original(await load(requestId), selected);
    return contract.view(existing, requestId);
  }
  let observed;
  try { observed = await evidence.observe(selected, deps); }
  catch (error) { return blocked(row, requestId, error); }
  const { preview, ...hashes } = observed;
  let saved;
  try {
    saved = await Confirmation.findOneAndUpdate({ _id: row._id, state: 'preparing', inputSha256: row.inputSha256 },
      { $set: { ...hashes, state: 'prepared', preparedAt: new Date() } }, { new: true, runValidators: true }).lean();
  } catch { saved = await load(requestId); }
  saved ||= await load(requestId);
  const displayed = saved.state === 'prepared' && saved.bindingSha256 === observed.bindingSha256;
  // The storage acknowledgement can await after the native observations.
  // Erasure or edits during that await must not release an old private preview.
  if (displayed) await evidence.assertCurrent(preview, deps);
  return contract.view(saved, requestId, { replayed: false,
    ...(displayed ? { preview } : {}) });
}

async function reopen(requestId, value, deps) {
  contract.owner(deps);
  const selected = contract.input(value, requestId, 'reopen');
  const row = original(await load(requestId), selected);
  if (row.state !== 'prepared') return contract.view(row, requestId);
  const observed = await evidence.observe(selected, deps);
  if (observed.bindingSha256 !== row.bindingSha256) throw contract.changed();
  // Reopening never replaces the prepared binding or changes state. If a
  // confirmation started while its read was pending, return that original.
  const current = original(await load(requestId), selected);
  const displayed = current.state === 'prepared' && current.bindingSha256 === row.bindingSha256;
  if (displayed) await evidence.assertCurrent(observed.preview, deps);
  return contract.view(current, requestId, {
    ...(displayed ? { preview: observed.preview } : {}) });
}

async function confirm(requestId, value, deps) {
  contract.owner(deps);
  const selected = contract.input(value, requestId, 'confirm');
  const row = original(await load(requestId), selected);
  if (value.bindingSha256 !== row.bindingSha256) throw contract.changed();
  if (row.state !== 'prepared') return contract.view(row, requestId);
  let reserved;
  try {
    reserved = await Confirmation.findOneAndUpdate({ _id: row._id, state: 'prepared', bindingSha256: row.bindingSha256 },
      { $set: { state: 'confirming' } }, { new: true, runValidators: true }).lean();
  } catch { return contract.view(await load(requestId), requestId); }
  if (!reserved) return contract.view(await load(requestId), requestId);
  let observed;
  try {
    observed = await evidence.observe(selected, deps);
    if (observed.bindingSha256 !== row.bindingSha256) throw contract.changed();
  } catch (error) { return blocked(reserved, requestId, error); }
  let saved;
  try {
    saved = await Confirmation.findOneAndUpdate({ _id: row._id, state: 'confirming', bindingSha256: row.bindingSha256 },
      { $set: { state: 'confirmed', confirmedAt: new Date() } }, { new: true, runValidators: true }).lean();
  } catch { saved = await load(requestId); }
  saved ||= await load(requestId);
  // Receipts do not export the sensitive preview or assert current approval.
  return contract.view(saved, requestId, { replayed: false });
}

function safe(action) {
  return async (...args) => {
    try { return await action(...args); }
    catch (error) {
      if (typeof error.code === 'string' && error.code.startsWith('HISTORY_MANIFEST_CONFIRMATION_')) throw error;
      if (error.statusCode === 409) throw contract.changed();
      if ([400, 403, 413].includes(error.statusCode)) throw failure('The selected confirmation request cannot be qualified.', error.statusCode,
        'HISTORY_MANIFEST_CONFIRMATION_INVALID');
      throw contract.unavailable();
    }
  };
}

module.exports = { prepare: safe(prepare), get: safe(get), reopen: safe(reopen), confirm: safe(confirm) };
