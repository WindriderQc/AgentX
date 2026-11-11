'use strict';

/** Core owns import identity, publication, duplicate decisions and immutable
 * verification receipts. The native receiver only transports this API.
 * No Immich mutation, model invocation, phone write or directory scan here.
 */
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { digest, fail, inside, verify, syncDir, writeJson, publishDirectory, safeDirectory } = require('./importFiles');

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const HASH = /^[0-9a-f]{64}$/;
const MEDIA = /\.(jpe?g|png|gif|webp|heic|heif|avif|tiff?|bmp|dng|raw|cr2|cr3|nef|arw|rw2|orf|raf|mpo|mp4|mov|m4v|3gp|3gpp|avi|mkv|webm|mts|m2ts|xmp|aae)$/i;
const validId = (id) => { if (!UUID.test(id || '')) throw fail('INVALID_ID', 'Expected a UUID'); return id.toLowerCase(); };
const text = (value, max = 4096) => typeof value === 'string' && value.length > 0 && value.length <= max && !value.includes('\0');
const readJson = async (file) => JSON.parse(await fs.readFile(file, 'utf8'));

function source(value) {
  if (!value || !text(value.key) || !text(value.name, 255) || !text(value.relativePath) ||
      !Number.isSafeInteger(value.size) || value.size <= 0 || !MEDIA.test(value.name)) throw fail('INVALID_SOURCE', 'Invalid or unsupported media source');
  return { key: value.key, name: value.name, relativePath: value.relativePath, size: value.size,
    modified: typeof value.modified === 'string' ? value.modified.slice(0, 100) : null };
}

async function createPhotoImportService({ root, findExisting = async () => ({ path: null, coverage: 'import-library-only' }) }) {
  if (!path.isAbsolute(root || '')) throw fail('INVALID_CONFIG', 'Import root must be absolute and already mounted');
  // Refuse absent Media/mounts instead of silently creating a backup on the OS disk.
  const actualRoot = await fs.realpath(root);
  if (actualRoot !== path.resolve(root) || !(await fs.lstat(root)).isDirectory()) throw fail('UNSAFE_PATH', 'Import root must be a real directory');
  const state = await safeDirectory(root, '.agentx-import');
  const staging = await safeDirectory(root, '.agentx-import/staging');
  const originals = await safeDirectory(root, 'Originals');
  const runs = await safeDirectory(root, '.agentx-import/runs');

  async function runRecord(runId) {
    validId(runId);
    return readJson(path.join(runs, runId, 'manifest.json'));
  }

  async function begin(input) {
    const runId = validId(input.runId);
    if (!HASH.test(input.deviceKey || '') || !Array.isArray(input.sources) || input.sources.length > 100000 || !input.sources.length) {
      throw fail('INVALID_MANIFEST', 'Expected a device identity and a nonempty bounded media manifest');
    }
    const sources = input.sources.map(s => ({ requestId: validId(s.requestId), ...source(s) }));
    if (new Set(sources.map(s => s.requestId)).size !== sources.length || new Set(sources.map(s => s.key)).size !== sources.length) throw fail('INVALID_MANIFEST', 'Duplicate source identity');
    const manifest = { schema: 'agentx.photo-import/v1', runId, deviceKey: input.deviceKey, sources,
      coverage: input.coverage || {}, phoneReadOnly: true };
    const temp = await fs.mkdtemp(path.join(staging, 'manifest-'));
    try {
      await writeJson(path.join(temp, 'manifest.json'), manifest);
      await safeDirectory(root, `.agentx-import/runs`);
      await publishDirectory(temp, path.join(runs, runId));
      const existing = await runRecord(runId);
      if (digest(JSON.stringify(existing)) !== digest(JSON.stringify(manifest))) throw fail('REQUEST_CONFLICT', 'Run identity already has another manifest');
      await safeDirectory(root, `.agentx-import/runs/${runId}/receipts`);
      await safeDirectory(root, `.agentx-import/runs/${runId}/intents`);
      return { runId, selected: sources.length, phoneReadOnly: true };
    } finally { await fs.rm(temp, { recursive: true, force: true }); }
  }

  async function context(input) {
    const runId = validId(input.runId), requestId = validId(input.requestId);
    if (!HASH.test(input.sha256 || '')) throw fail('INVALID_HASH', 'Expected SHA-256 of the source stream');
    const run = await runRecord(runId);
    const item = run.sources.find(s => s.requestId === requestId);
    if (!item || input.size !== item.size) throw fail('REQUEST_CONFLICT', 'Source does not match the frozen manifest');
    const intentDir = path.join(runs, runId, 'intents', requestId);
    const temp = await fs.mkdtemp(path.join(staging, 'intent-'));
    try {
      await writeJson(path.join(temp, 'intent.json'), { sha256: input.sha256, size: input.size });
      await publishDirectory(temp, intentDir);
      const intent = await readJson(path.join(intentDir, 'intent.json'));
      if (intent.sha256 !== input.sha256 || intent.size !== input.size) throw fail('REQUEST_CONFLICT', 'Request content identity is already frozen');
    } finally { await fs.rm(temp, { recursive: true, force: true }); }
    return { runId, requestId, sha256: input.sha256, size: item.size, source: item,
      receiptDir: path.join(runs, runId, 'receipts', requestId) };
  }

  async function existingReceipt(ctx) {
    let receipt;
    try { receipt = await readJson(path.join(ctx.receiptDir, 'receipt.json')); }
    catch (error) { if (error.code === 'ENOENT') return null; throw error; }
    if (receipt.sha256 !== ctx.sha256 || receipt.size !== ctx.size) throw fail('REQUEST_CONFLICT', 'Request identity already has another content hash');
    await verify(receipt.path, ctx);
    return { ...receipt, reconciled: true };
  }

  async function ownContent(ctx) {
    const dir = path.join(originals, ctx.sha256.slice(0, 2), ctx.sha256);
    let content;
    try { content = await readJson(path.join(dir, 'content.json')); }
    catch (error) { if (error.code === 'ENOENT') return null; throw error; }
    if (content.sha256 !== ctx.sha256 || path.basename(content.file || '') !== content.file) throw fail('INVALID_CONTENT', 'Invalid content receipt');
    const file = path.join(dir, content.file);
    if (!inside(root, await fs.realpath(file))) throw fail('UNSAFE_PATH', 'Content leaves import root');
    await verify(file, ctx);
    return { path: file, requestId: content.requestId };
  }

  async function receipt(ctx, file, disposition, coverage) {
    await verify(file, ctx);
    const value = { schema: 'agentx.photo-import-receipt/v1', runId: ctx.runId, requestId: ctx.requestId,
      sha256: ctx.sha256, size: ctx.size, source: ctx.source, path: file, disposition, coverage,
      verifiedAt: new Date().toISOString(), verification: 'source-stream-sha256-and-destination-readback', phoneReadOnly: true };
    const temp = await fs.mkdtemp(path.join(staging, 'receipt-'));
    try {
      await writeJson(path.join(temp, 'receipt.json'), value);
      await publishDirectory(temp, ctx.receiptDir);
      return existingReceipt(ctx);
    } finally { await fs.rm(temp, { recursive: true, force: true }); }
  }

  async function lookup(input) {
    const ctx = await context(input);
    const known = await existingReceipt(ctx);
    if (known) return known;
    const own = await ownContent(ctx);
    if (own) return receipt(ctx, own.path, own.requestId === ctx.requestId ? 'copied' : 'duplicate', 'import-library');
    const candidate = await findExisting(ctx);
    if (candidate.path) return receipt(ctx, candidate.path, 'duplicate', candidate.coverage);
    return { needsUpload: true, runId: ctx.runId, requestId: ctx.requestId, coverage: candidate.coverage };
  }

  async function receive(input, stream) {
    const ctx = await context(input);
    const prior = await existingReceipt(ctx);
    if (prior) { for await (const _ of stream) { /* drain this transport */ } return prior; }
    const temp = await fs.mkdtemp(path.join(staging, 'content-'));
    const fileName = 'original' + path.extname(ctx.source.name).toLowerCase();
    const file = path.join(temp, fileName);
    try {
      const handle = await fs.open(file, 'wx', 0o600);
      const hash = crypto.createHash('sha256');
      let bytes = 0;
      try {
        for await (const chunk of stream) {
          bytes += chunk.length;
          if (bytes > ctx.size) throw fail('SOURCE_SIZE_MISMATCH', 'Source stream exceeds manifest size');
          hash.update(chunk);
          await handle.writeFile(chunk);
        }
        await handle.sync();
      } finally { await handle.close(); }
      if (bytes !== ctx.size || hash.digest('hex') !== ctx.sha256) throw fail('SOURCE_HASH_MISMATCH', 'Incomplete or changed source stream');
      await verify(file, ctx);
      await writeJson(path.join(temp, 'content.json'), { sha256: ctx.sha256, size: ctx.size, file: fileName, requestId: ctx.requestId });
      await syncDir(temp);
      const parent = await safeDirectory(root, `Originals/${ctx.sha256.slice(0, 2)}`);
      const published = await publishDirectory(temp, path.join(parent, ctx.sha256));
      const content = await ownContent(ctx);
      return receipt(ctx, content.path, published || content.requestId === ctx.requestId ? 'copied' : 'duplicate', 'import-library');
    } finally { await fs.rm(temp, { recursive: true, force: true }); }
  }

  async function status(input) {
    const run = await runRecord(validId(input.runId));
    const counts = { selected: run.sources.length, copied: 0, duplicates: 0, pending: 0, failedVerification: 0 };
    for (const item of run.sources) {
      let record;
      try { record = await readJson(path.join(runs, run.runId, 'receipts', item.requestId, 'receipt.json')); }
      catch (error) { if (error.code === 'ENOENT') { counts.pending++; continue; } throw error; }
      try { await verify(record.path, record); counts[record.disposition === 'copied' ? 'copied' : 'duplicates']++; }
      catch { counts.failedVerification++; }
    }
    const libraryCoverageComplete = run.coverage.enumerationComplete === true && !run.coverage.remaining;
    return { runId: run.runId, state: counts.pending || counts.failedVerification || !libraryCoverageComplete ? 'incomplete' : 'complete', counts, libraryCoverageComplete,
      coverage: run.coverage, phoneReadOnly: true };
  }

  return { begin, lookup, receive, status, root, state };
}

module.exports = { createPhotoImportService, MEDIA };
