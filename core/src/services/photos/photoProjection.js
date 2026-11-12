'use strict';

// A managed external-library view over verified imports. Hard links add no
// second original bytes; mutable gallery sidecars remain separate from them.
const fs = require('node:fs/promises'), path = require('node:path');
const { createReadStream } = require('node:fs'), crypto = require('node:crypto');
const { createPhoneLibrary, id, optional, hash } = require('./phoneLibrary');
const { fail, inside, verify, safeDirectory, writeJson, publishDirectory, syncDir } = require('./importFiles');
const { sourceExtension } = require('./importFormats');
const SHA = /^[a-f0-9]{64}$/;
const LIBRARY = '.agentx-import/immich-library';

function fileName(source, sha256) {
  const extension = sourceExtension(source);
  if (!extension || ['.xmp', '.aae'].includes(extension)) return null;
  const name = source.name;
  return sourceExtension({ name }) && typeof name === 'string' && name.length <= 220 && !/[\\/\x00-\x1f\x7f]/.test(name)
    && !['.', '..'].includes(name) ? name : sha256 + extension;
}

async function createPhotoProjection(config) {
  const library = await createPhoneLibrary(config), root = library.root;
  const references = await safeDirectory(root, '.agentx-import/gallery-references');
  const intents = await safeDirectory(root, '.agentx-import/gallery-operations');
  const directory = await safeDirectory(root, LIBRARY);
  const approved = [root, ...(config.inventory?.mappings || []).map(m => m.physicalRoot)];
  async function source(runId, requestId) {
    const entry = await library.occurrence(id(runId), id(requestId));
    const receipt = entry.receipt;
    if (!receipt || !SHA.test(receipt.sha256)) throw fail('BACKUP_REQUIRED', 'A verified import receipt is required');
    const file = path.resolve(receipt.path), real = await fs.realpath(file);
    if (real !== file || !approved.some(p => typeof p === 'string' && inside(path.resolve(p), real)))
      throw fail('UNSAFE_PATH', 'Original is outside the approved import sources');
    await verify(real, receipt);
    return { ...entry, file };
  }
  async function claim(entry, runId, requestId) {
    const { receipt } = entry;
    const slot = path.join(references, receipt.sha256);
    let saved = await optional(path.join(slot, 'intent.json'));
    if (!saved) {
      const name = fileName(entry.source, receipt.sha256);
      if (!name) return null;
      const relativePath = [runId, hash(path.posix.dirname(entry.source.relativePath)), name].join('/');
      const value = { schema: 'agentx.photo-projection/v1', sha256: receipt.sha256, size: receipt.size,
        relativePath, runId, requestId, createdAt: new Date().toISOString() };
      const temporary = await fs.mkdtemp(path.join(root, '.agentx-import/staging/projection-'));
      try {
        await writeJson(path.join(temporary, 'intent.json'), value);
        await publishDirectory(temporary, slot);
      } finally { await fs.rm(temporary, { recursive: true, force: true }); }
      saved = await optional(path.join(slot, 'intent.json'));
    }
    if (saved.sha256 !== receipt.sha256 || saved.size !== receipt.size)
      throw fail('REQUEST_CONFLICT', 'Projection content identity differs');
    return { slot, saved };
  }
  async function existing(sha256) {
    if (!SHA.test(sha256 || '')) throw fail('INVALID_ID', 'Expected a content SHA-256');
    const receipt = await optional(path.join(references, sha256, 'result', 'receipt.json'));
    if (!receipt) return null;
    if (receipt.sha256 !== sha256) throw fail('INVALID_RECEIPT', 'Projection receipt has another content identity');
    const file = path.resolve(directory, receipt.relativePath);
    if (!inside(directory, file) || await fs.realpath(file) !== file)
      throw fail('UNSAFE_PATH', 'Gallery reference is unavailable');
    await verify(file, receipt);
    return receipt;
  }
  async function projectOne(runId, requestId) {
    const entry = await source(runId, requestId);
    const known = await existing(entry.receipt.sha256);
    if (known) return { ...known, sourceRequestId: requestId, reused: true };
    const chosen = await claim(entry, runId, requestId);
    if (!chosen) return { sourceRequestId: requestId, skipped: 'companion', sha256: entry.receipt.sha256 };
    const { slot, saved } = chosen;
    const components = saved.relativePath.split('/');
    // Older unpublished intents may retain an extensionless signature match.
    // Keep that immutable intent while publishing a usable gallery filename.
    if (components.length === 3 && !sourceExtension({ name: components[2] })
      && components[2].length <= 220 && !/[\\/\x00-\x1f\x7f]/.test(components[2])
      && !['.', '..'].includes(components[2]) && fileName(entry.source, saved.sha256))
      components[2] = saved.sha256 + sourceExtension(entry.source);
    const relativePath = components.join('/');
    if (components.length !== 3 || !SHA.test(components[1]) || id(components[0]) !== components[0]
      || fileName({ name: components[2] }, saved.sha256) !== components[2])
      throw fail('UNSAFE_PATH', 'Invalid gallery reference intent');
    const parent = await safeDirectory(directory, components.slice(0, 2).join('/'));
    const target = path.join(parent, components[2]);
    try { await fs.link(entry.file, target); await syncDir(parent); }
    catch (error) {
      if (error.code === 'EXDEV') throw fail('PROJECTION_VOLUME_MISMATCH', 'Gallery references require the same filesystem; no extra copy was made');
      if (error.code !== 'EEXIST') throw error;
    }
    if (await fs.realpath(target) !== target) throw fail('UNSAFE_PATH', 'Gallery reference cannot be a symlink');
    await verify(target, entry.receipt);
    const [originalStat, projectedStat] = await Promise.all([fs.lstat(entry.file), fs.lstat(target)]);
    if (originalStat.dev !== projectedStat.dev || originalStat.ino !== projectedStat.ino)
      throw fail('PROJECTION_CONFLICT', 'The managed reference is not the original hard link');
    const sha1 = crypto.createHash('sha1');
    for await (const chunk of createReadStream(target)) sha1.update(chunk);
    // Legacy content SHA-1 supplements the canonical SHA-256 proof. Immich
    // external-library assets may expose a path digest instead of this value.
    const value = { ...saved, relativePath, ...(relativePath === saved.relativePath ? {} : { legacyIntentPath: saved.relativePath }), kind: 'hardlink', immichChecksum: sha1.digest('base64') };
    const temporary = await fs.mkdtemp(path.join(root, '.agentx-import/staging/projection-receipt-'));
    try {
      await writeJson(path.join(temporary, 'receipt.json'), value);
      await publishDirectory(temporary, path.join(slot, 'result'));
    } finally { await fs.rm(temporary, { recursive: true, force: true }); }
    return { ...await existing(saved.sha256), sourceRequestId: requestId, reused: false };
  }
  async function project(input) {
    const operationId = id(input.operationId), runId = id(input.runId);
    if (!Array.isArray(input.items) || !input.items.length || input.items.length > 100)
      throw fail('INVALID_SELECTION', 'Select between one and one hundred verified imports');
    const items = [...new Set(input.items.map(id))].sort();
    await library.immutable(intents, operationId, { operationId, runId, items });
    const results = [];
    for (const requestId of items) results.push(await projectOne(runId, requestId));
    return { operationId, results };
  }
  async function exportCard(input) {
    const sha256 = input.sha256, analysisId = id(input.analysisId);
    const receipt = await existing(sha256);
    if (!receipt) throw fail('PROJECTION_REQUIRED', 'Project verified media before exporting a card');
    if (!input.card || input.card.sourceSha256 !== sha256 || input.card.analysisId !== analysisId
      || Buffer.byteLength(JSON.stringify(input.card)) > 65536)
      throw fail('INVALID_CARD', 'Card provenance must match the verified content and analysis');
    const parent = await safeDirectory(root, '.agentx-import/gallery-cards/' + sha256);
    await library.immutable(parent, analysisId, input.card);
    return { sha256, analysisId, exported: true };
  }
  const syncTags = require('./photoProjectionTags').createPhotoProjectionTags({ root, directory, library, existing });
  return { project, existing, exportCard, syncTags, directory };
}

module.exports = { createPhotoProjection, fileName, LIBRARY };
