'use strict';
const crypto = require('node:crypto');
const { defaultArchive } = require('../imageArchive');
const { decode } = require('./codec');
const { TRANSFORM } = require('./parentReference');
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const unavailable = () => Object.assign(new Error('Image references unavailable or inconsistent'), { statusCode: 503 });
const requireValid = value => { if (!value) throw unavailable(); };

function checkedImage(bytes) {
  const image = decode(bytes, 4194304);
  requireValid(Math.max(image.width, image.height) / Math.min(image.width, image.height) <= 8);
  return image;
}

function receipt(stored, image) {
  requireValid(stored && ['uploaded', 'generated'].includes(stored.origin) && typeof stored.archivedAt === 'string'
    && Number.isFinite(Date.parse(stored.archivedAt)));
  return { path: stored.path, sha256: stored.sha256, mimeType: stored.mimeType, size: stored.size,
    origin: stored.origin, archivedAt: stored.archivedAt, width: image.width, height: image.height };
}

function descriptors(op, count) {
  const lineage = op.lineage;
  if (!lineage) { requireValid(count === 0 || !Object.hasOwn(op, 'referenceStorage')); return null; }
  requireValid(lineage.version === 1 && Array.isArray(lineage.references) && lineage.references.length === count);
  for (const entry of lineage.references) requireValid(entry && entry.transform === TRANSFORM
    && typeof entry.sourceSha256 === 'string' && /^[0-9a-f]{64}$/.test(entry.sourceSha256)
    && typeof entry.workerSha256 === 'string' && /^[0-9a-f]{64}$/.test(entry.workerSha256));
  if (lineage.parent) requireValid(count > 0 && lineage.references[0].parentOperationId === lineage.parent.operationId
    && lineage.references[0].sourceSha256 === lineage.parent.sha256);
  return lineage.references;
}

async function loadReferences(op) {
  try {
    if (!Object.hasOwn(op, 'referenceStorage')) {
      const legacy = op.references === undefined ? [] : op.references;
      requireValid(Array.isArray(legacy) && legacy.length <= 2);
      const declared = descriptors(op, legacy.length);
      return legacy.map((item, index) => {
        const bytes = Buffer.isBuffer(item) ? item : item?._bsontype === 'Binary'
          ? Buffer.from(item.buffer.subarray(0, item.position)) : Buffer.from(item);
        checkedImage(bytes);
        if (declared) requireValid(hash(bytes) === declared[index].workerSha256);
        return bytes;
      });
    }
    const storage = op.referenceStorage;
    requireValid(storage && storage.version === 1 && Array.isArray(storage.entries) && storage.entries.length > 0 && storage.entries.length <= 2);
    const declared = descriptors(op, storage.entries.length);
    requireValid(declared);
    const loaded = [];
    for (let i = 0; i < storage.entries.length; i++) {
      const entry = storage.entries[i], expected = declared[i];
      requireValid(entry?.source?.sha256 === expected.sourceSha256 && entry?.worker?.sha256 === expected.workerSha256);
      const source = await defaultArchive().read(entry.source), worker = await defaultArchive().read(entry.worker);
      const sourceImage = checkedImage(source.bytes), workerImage = checkedImage(worker.bytes);
      requireValid(worker.mimeType === 'image/png' && sourceImage.width === workerImage.width && sourceImage.height === workerImage.height);
      for (const [saved, actual] of [[entry.source, sourceImage], [entry.worker, workerImage]]) {
        receipt(saved, actual);
        requireValid(saved.width === actual.width && saved.height === actual.height);
      }
      if (op.lineage.parent && i === 0) requireValid(sourceImage.width === op.lineage.parent.width && sourceImage.height === op.lineage.parent.height);
      loaded.push(worker.bytes);
    }
    return loaded;
  } catch { throw unavailable(); }
}

async function retainReferences(prepared) {
  try {
    requireValid(Array.isArray(prepared.sources) && Array.isArray(prepared.references) && prepared.sources.length === prepared.references.length && prepared.sources.length <= 2);
    if (!prepared.sources.length) return undefined;
    const declared = descriptors({ referenceStorage: true, lineage: prepared.lineage }, prepared.sources.length);
    requireValid(declared);
    const entries = [];
    for (let i = 0; i < prepared.sources.length; i++) {
      const source = prepared.sources[i], worker = prepared.references[i];
      const sourceImage = checkedImage(source), workerImage = checkedImage(worker);
      requireValid(hash(source) === declared[i].sourceSha256 && hash(worker) === declared[i].workerSha256 && workerImage.mimeType === 'image/png');
      const existing = i === 0 ? prepared.parentArtifact : null;
      const sourceStored = existing?.origin && existing.archivedAt ? existing
        : await defaultArchive().store({ bytes: source, origin: 'uploaded', context: {} });
      const workerStored = await defaultArchive().store({ bytes: worker, origin: 'uploaded', context: {} });
      entries.push({ source: receipt(sourceStored, sourceImage), worker: receipt(workerStored, workerImage) });
    }
    const storage = { version: 1, entries };
    await loadReferences({ referenceStorage: storage, lineage: prepared.lineage });
    return storage;
  } catch { throw unavailable(); }
}

module.exports = { retainReferences, loadReferences };
