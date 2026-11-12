'use strict';

// Core's import ledger is also the source of the phone workbench. This is a
// paged projection and review journal, not a second photo/content catalogue.
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { fail, safeDirectory, writeJson, publishDirectory, verify, digest } = require('./importFiles');
const { sourceExtension } = require('./importFormats');

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const id = (value) => {
  if (!UUID.test(value || '')) throw fail('INVALID_ID', 'Expected a UUID');
  return value.toLowerCase();
};
const read = (file) => fs.readFile(file, 'utf8').then(JSON.parse);
const coverageView = (value) => ({
  enumerationComplete: value?.enumerationComplete === true,
  signatureAuditComplete: value?.signatureAuditComplete,
  remaining: value?.remaining || 0,
  unprobedFiles: value?.unprobedFiles || 0,
  signatureErrorCount: value?.signatureErrors?.length || 0,
  enumerationErrorCount: value?.enumerationErrors?.length || 0,
  inaccessibleScope: String(value?.inaccessibleScope || '').slice(0, 512),
});
const hash = (value) => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
async function optional(file) {
  try {
    return await read(file);
  } catch (e) {
    if (e.code === 'ENOENT') return null;
    throw e;
  }
}

async function createPhoneLibrary(config) {
  const root = await fs.realpath(config.root);
  if (root !== path.resolve(config.root)) throw fail('UNSAFE_PATH', 'Import root cannot be a symlink');
  if (config.expectedDevice !== undefined && (await fs.stat(root)).dev !== config.expectedDevice)
    throw fail('MEDIA_VOLUME_MISMATCH', 'Media is unavailable');
  const ledger = await safeDirectory(root, '.agentx-import');
  const state = await safeDirectory(root, '.agentx-import/phone');
  const staging = await safeDirectory(root, '.agentx-import/staging');
  async function immutable(parent, name, value) {
    const temp = await fs.mkdtemp(path.join(staging, 'phone-'));
    try {
      await writeJson(path.join(temp, 'value.json'), value);
      await publishDirectory(temp, path.join(parent, name));
      const existing = await read(path.join(parent, name, 'value.json'));
      if (hash(existing) !== hash(value))
        throw fail('REQUEST_CONFLICT', 'This identity already has another intent');
      return existing;
    } finally {
      await fs.rm(temp, { recursive: true, force: true });
    }
  }
  async function manifest(runId) {
    return read(path.join(ledger, 'runs', id(runId), 'manifest.json'));
  }
  async function occurrence(runId, requestId, verified = false) {
    const run = await manifest(runId);
    const source = run.sources.find((item) => item.requestId === id(requestId));
    if (!source) throw fail('SOURCE_NOT_FOUND', 'Source is outside this import');
    const receipt = await optional(
      path.join(ledger, 'runs', id(runId), 'receipts', id(requestId), 'receipt.json'),
    );
    if (
      receipt &&
      (receipt.requestId !== requestId ||
        receipt.runId !== runId ||
        receipt.size !== source.size ||
        hash(receipt.source) !== hash(source))
    )
      throw fail('INVALID_RECEIPT', 'Source receipt does not match its manifest');
    if (verified) {
      if (!receipt || !/^[a-f0-9]{64}$/.test(receipt.sha256))
        throw fail('BACKUP_REQUIRED', 'A verified Media copy is required');
      await verify(receipt.path, receipt);
    }
    return { run, source, receipt };
  }
  async function review(runId, requestId) {
    const dir = path.join(state, 'reviews', id(runId), id(requestId));
    let names;
    try {
      names = await fs.readdir(dir);
    } catch (e) {
      if (e.code === 'ENOENT') return { revision: 0, choice: 'review' };
      throw e;
    }
    const versions = names
      .filter((x) => /^[1-9][0-9]*$/.test(x))
      .map(Number)
      .sort((a, b) => b - a);
    return versions.length
      ? read(path.join(dir, String(versions[0]), 'value.json'))
      : { revision: 0, choice: 'review' };
  }
  async function list() {
    const dir = path.join(ledger, 'runs');
    let names;
    try {
      names = (await fs.readdir(dir)).filter((x) => UUID.test(x));
    } catch (e) {
      if (e.code === 'ENOENT') return { runs: [] };
      throw e;
    }
    if (names.length > 2000) throw fail('LEDGER_LIMIT', 'Import history needs pagination before continuing');
    const dates = await Promise.all(
      names.map(async (runId) => ({
        runId,
        at: (await fs.stat(path.join(dir, runId, 'manifest.json'))).mtimeMs,
      })),
    );
    const runs = [];
    for (const row of dates.sort((a, b) => b.at - a.at).slice(0, 40)) {
      const value = await manifest(row.runId);
      runs.push({
        runId: row.runId,
        at: new Date(row.at).toISOString(),
        selected: value.sources.length,
        coverage: coverageView(value.coverage),
      });
    }
    return { runs, total: names.length };
  }
  const subjectKey = (run, source, sha256) =>
    digest(
      JSON.stringify([run.deviceKey, source.key, source.relativePath, source.modified, source.size, sha256]),
    );
  async function phoneState(run, source, receipt) {
    if (!receipt) return 'not-requested';
    const claim = await optional(
      path.join(state, 'claims', subjectKey(run, source, receipt.sha256), 'value.json'),
    );
    if (!claim) return 'not-requested';
    const result = await optional(
      path.join(state, 'cleanup', id(claim.planId), 'results', id(claim.requestId), 'value.json'),
    );
    return result?.state === 'deleted' ? 'deleted' : 'uncertain';
  }
  async function page(input) {
    const run = await manifest(input.runId);
    const offset = Number(input.offset || 0),
      limit = Number(input.limit || 24);
    if (
      !Number.isInteger(offset) ||
      offset < 0 ||
      !Number.isInteger(limit) ||
      limit < 1 ||
      limit > 100 ||
      typeof (input.search || '') !== 'string' ||
      (input.search || '').length > 200
    )
      throw fail('INVALID_QUERY', 'Invalid page');
    const search = (input.search || '').toLocaleLowerCase();
    const sources = run.sources.filter((x) => !search || x.relativePath.toLocaleLowerCase().includes(search));
    if (input.order === 'size')
      sources.sort((a, b) => b.size - a.size || a.requestId.localeCompare(b.requestId));
    const items = [];
    for (const item of sources.slice(offset, offset + limit)) {
      const { receipt } = await occurrence(input.runId, item.requestId);
      items.push({
        ...item,
        format: sourceExtension(item),
        backup: receipt
          ? { disposition: receipt.disposition, verifiedAt: receipt.verifiedAt, sha256: receipt.sha256 }
          : null,
        review: await review(input.runId, item.requestId),
        phone: await phoneState(run, item, receipt),
      });
    }
    return {
      runId: input.runId,
      deviceKey: run.deviceKey,
      coverage: coverageView(run.coverage),
      items,
      total: sources.length,
      offset,
      limit,
    };
  }
  async function setReview(input) {
    id(input.writeId);
    if (
      !['review', 'keep', 'archive'].includes(input.choice) ||
      !Number.isInteger(input.expectedRevision) ||
      input.expectedRevision < 0
    )
      throw fail('INVALID_REVIEW', 'Invalid review');
    await occurrence(input.runId, input.requestId);
    const dir = await safeDirectory(
      root,
      `.agentx-import/phone/reviews/${id(input.runId)}/${id(input.requestId)}`,
    );
    const revision = input.expectedRevision + 1;
    const target = path.join(dir, String(revision), 'value.json');
    const saved = await optional(target);
    if (saved?.writeId === input.writeId && saved.choice === input.choice) return saved;
    const current = await review(input.runId, input.requestId);
    if (current.revision !== input.expectedRevision)
      throw fail('REVIEW_CHANGED', 'Refresh the current review');
    return immutable(dir, String(revision), { revision, writeId: input.writeId, choice: input.choice });
  }
  async function preview(input) {
    const { source, receipt } = await occurrence(input.runId, input.requestId);
    if (
      !receipt ||
      !/^\.(jpg|jpeg|jpe|jfif|png|webp|gif|heic|heif|avif|tiff?|bmp)$/i.test(sourceExtension(source) || '') ||
      receipt.size > 8 * 1024 * 1024
    )
      throw fail('PREVIEW_UNAVAILABLE', 'Preview unavailable for this format/size');
    const file = await fs.open(receipt.path, 'r');
    try {
      if (!(await file.stat()).isFile() || (await file.stat()).size !== receipt.size)
        throw fail('PREVIEW_UNAVAILABLE', 'Media changed');
      const bytes = Buffer.alloc(receipt.size);
      let offset = 0;
      while (offset < bytes.length) {
        const got = await file.read(bytes, offset, bytes.length - offset, offset);
        if (!got.bytesRead) throw fail('PREVIEW_UNAVAILABLE', 'Media was truncated');
        offset += got.bytesRead;
      }
      return { bytes: bytes.toString('base64'), sha256: receipt.sha256 };
    } finally {
      await file.close();
    }
  }
  return {
    root,
    state,
    immutable,
    manifest,
    occurrence,
    review,
    list,
    page,
    setReview,
    preview,
    phoneState,
    subjectKey,
  };
}

module.exports = { createPhoneLibrary, id, read, optional, hash };
