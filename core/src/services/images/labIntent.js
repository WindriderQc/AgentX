'use strict';
// Catalogue evidence is read from the instance archive. Preparing an intent never admits work.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const IDS = ['scenes', 'edit', 'finish16'];
const sha = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const fail = (message, statusCode = 400) => Object.assign(new Error(message), { statusCode });
const plain = value => value && typeof value === 'object' && !Array.isArray(value);
const fields = (value, allowed) => plain(value) && Object.keys(value).every(key => allowed.includes(key));
const root = () => process.env.IMAGE_ARCHIVE_DIR && path.join(path.resolve(process.env.IMAGE_ARCHIVE_DIR), 'atelier-site');
const scalar = value => typeof value === 'string' || (typeof value === 'number' && Number.isFinite(value)) ? value : null;
const integer = value => {
  if (value == null) return null;
  if (!Number.isSafeInteger(value) || value < 0) throw fail('Invalid catalogue integer value.', 503);
  return value;
};

function entry(record, kind, catalogueId) {
  if (!plain(record) || typeof record.id !== 'string' || !/^[a-zA-Z0-9._:-]{1,180}$/.test(record.id)) throw fail('Invalid catalogue entry.', 503);
  const parameters = Object.fromEntries(['seed', 'steps', 'cfg', 'sampler_name', 'scheduler', 'denoise']
    .map(key => [key, ['seed', 'steps'].includes(key) ? integer(record.parameters?.[key] ?? record[key]) : scalar(record.parameters?.[key] ?? record[key])]));
  const parents = kind === 'maxRun' ? (record.parentSHA256 ? [record.parentSHA256] : []) : (record.parents ?? []);
  if (!Array.isArray(parents) || parents.some(value => !sha(value))) throw fail('Invalid catalogue lineage.', 503);
  if (catalogueId === 'finish16' && !['native', 'refine'].includes(record.role)) throw fail('Unknown catalogue pass.', 503);
  if ((catalogueId === 'finish16') !== (kind === 'maxRun') || (catalogueId !== 'finish16' && record.role != null)
      || (record.role === 'refine' && parents.length !== 1) || (record.role === 'native' && parents.length !== 0)) throw fail('Incompatible catalogue pass and lineage.', 503);
  return { id: record.id, kind, title: scalar(record.title) || scalar(record.case) || record.id,
    operation: catalogueId === 'edit' ? 'reference_edit' : catalogueId === 'finish16' && record.role === 'refine' ? 'reference_finish' : 'text_to_image',
    role: scalar(record.role), width: integer(record.width), height: integer(record.height),
    prompt: typeof record.brief === 'string' ? record.brief : null, model: scalar(record.model), parameters,
    originalSha256: sha(record.sha256 ?? record.originalSHA256) ? (record.sha256 ?? record.originalSHA256) : null,
    graphSha256: sha(record.graphSHA256) ? record.graphSHA256 : null, declaredParentSha256: parents,
    components: (Array.isArray(record.components) ? record.components : []).map(component => ({
      nodeType: scalar(component.nodeType), file: scalar(component.file),
      sha256: sha(component.provenance?.sha256) ? component.provenance.sha256 : null,
      revision: scalar(component.provenance?.revision)
    })) };
}

function catalogue(id, dataRoot = root()) {
  if (!IDS.includes(id)) throw fail('Unknown catalogue.');
  if (!dataRoot) throw fail('The lab recipes are unavailable.', 503);
  let bytes, data, descriptor;
  try {
    const filename = path.join(dataRoot, 'lab-resources', 'ready', 'recipes', id + '.json');
    if (!fs.lstatSync(filename).isFile()) throw new Error('not a regular catalogue');
    descriptor = fs.openSync(filename, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0) | (fs.constants.O_NONBLOCK || 0));
    const before = fs.fstatSync(descriptor);
    if (!before.isFile() || before.size > 2 * 1024 * 1024) throw new Error('oversized');
    bytes = Buffer.alloc(before.size);
    let offset = 0;
    while (offset < bytes.length) {
      const count = fs.readSync(descriptor, bytes, offset, bytes.length - offset, offset);
      if (!count) throw new Error('truncated');
      offset += count;
    }
    const after = fs.fstatSync(descriptor);
    if (after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs) throw new Error('changed');
    data = JSON.parse(bytes);
  } catch { throw fail('The lab recipes are unavailable.', 503); }
  finally { if (descriptor !== undefined) fs.closeSync(descriptor); }
  if (data.id !== id || data.schemaVersion !== 1 || !Array.isArray(data.records) || !Array.isArray(data.maxRuns)) throw fail('Incompatible catalogue.', 503);
  const entries = [...data.records.map(value => entry(value, 'record', id)), ...data.maxRuns.map(value => entry(value, 'maxRun', id))];
  if (new Set(entries.map(value => value.kind + ':' + value.id)).size !== entries.length) throw fail('Ambiguous recipe identity.', 503);
  return { id, schemaVersion: data.schemaVersion, sha256: crypto.createHash('sha256').update(bytes).digest('hex'),
    title: scalar(data.title) || id, model: scalar(data.model), state: 'prepared_only', automaticDispatch: false, entries };
}

function prepare(body, dataRoot = root()) {
  if (!fields(body, ['labSelection', 'prompt', 'width', 'height', 'seed', 'approvedElements'])
      || !fields(body.labSelection, ['catalogueId', 'catalogueSha256', 'kind', 'entryId'])) throw fail('Invalid recipe intent.');
  const selection = body.labSelection;
  if (!IDS.includes(selection.catalogueId) || !sha(selection.catalogueSha256)
      || !['record', 'maxRun'].includes(selection.kind) || typeof selection.entryId !== 'string') throw fail('Invalid recipe selection.');
  const source = catalogue(selection.catalogueId, dataRoot);
  if (source.sha256 !== selection.catalogueSha256) throw fail('The catalogue changed. Reload the recipes before preparing the plan.', 409);
  const chosen = source.entries.find(value => value.kind === selection.kind && value.id === selection.entryId);
  if (!chosen) throw fail('This entry is no longer in the catalogue.', 409);
  if (typeof body.prompt !== 'string' || !body.prompt.trim() || body.prompt.length > 8000) throw fail('The brief is required, with at most 8,000 characters.');
  if (![body.width, body.height].every(value => Number.isInteger(value) && value >= 256 && value <= 8192 && value % 32 === 0)) throw fail('Dimensions: 256 to 8192 px, multiples of 32.');
  if (!Number.isSafeInteger(body.seed) || body.seed < 0 || body.seed > 2 ** 48 - 1) throw fail('Invalid seed.');
  if (body.approvedElements !== undefined && (typeof body.approvedElements !== 'string' || body.approvedElements.length > 2000)) throw fail('Elements to keep: at most 2,000 characters.');
  return { schemaVersion: 1, id: 'lab-intent-' + crypto.randomUUID(), createdAtUtc: new Date().toISOString(),
    state: 'prepared_only', automaticDispatch: false, labSelection: { ...selection }, catalogueSchemaVersion: source.schemaVersion,
    operation: chosen.operation, evidence: chosen,
    request: { prompt: body.prompt.trim(), width: body.width, height: body.height, seed: body.seed,
      approvedElements: body.approvedElements?.trim() || '' },
    qualification: 'Preparation only; catalogue evidence is not an executable Core recipe or a verified Core parent.',
    requiredChecks: ['Qualify the execution recipe and its component revisions', 'Resolve and verify exact Core parent identities for referenced work',
      'Admit physical resources and requested dimensions', 'Check composition and requested preserved elements', 'Archive result and verify restoration'],
    totalToUsableSeconds: null };
}

function assertSupportedRequest(body) {
  if (plain(body) && (Object.hasOwn(body, 'labSelection') || body.state === 'prepared_only')) {
    throw fail('This lab intent is prepared only. Its recipe must be integrated before any generation.', 409);
  }
}

module.exports = { IDS, catalogue, prepare, assertSupportedRequest };
