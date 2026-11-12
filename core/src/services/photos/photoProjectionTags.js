'use strict';

// Only AgentX-owned gallery sidecars are writable. Neither original media nor
// backed-up XMP companions enter this namespace.
const fs = require('node:fs/promises'), path = require('node:path');
const { id, hash, optional } = require('./phoneLibrary');
const { fail, digest, safeDirectory, syncDir } = require('./importFiles');
function tagList(tags) {
  if (!Array.isArray(tags) || tags.length > 256 || tags.some(t => typeof t !== 'string' || !t.length
    || t.length > 1024 || /[\x00-\x1f\x7f\ud800-\udfff\ufffe\uffff]/u.test(t)) || Buffer.byteLength(JSON.stringify(tags)) > 48000)
    throw fail('INVALID_PHOTO_TAGS', 'Expected a bounded complete tag set');
  return [...new Set(tags)].sort();
}
const escape = text => text.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[c]));
function xmp(value) {
  return '<?xml version="1.0" encoding="UTF-8"?>\n'
    + '<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">'
    + '<rdf:Description rdf:about="" xmlns:digiKam="http://www.digikam.org/ns/1.0/" '
    + 'xmlns:agentx="https://agentx.local/ns/photo-sidecar/1.0/" agentx:sourceSha256="'+value.sha256+'" '
    + 'agentx:writeId="'+value.writeId+'" agentx:revision="'+value.revision+'">'
    + '<digiKam:TagsList><rdf:Seq>'+value.tags.map(t => '<rdf:li>'+escape(t)+'</rdf:li>').join('')
    + '</rdf:Seq></digiKam:TagsList></rdf:Description></rdf:RDF></x:xmpmeta>\n';
}
async function fileBytes(file) {
  try {
    const stat = await fs.lstat(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > 65536)
      throw fail('PHOTO_SIDECAR_CONFLICT', 'A gallery sidecar must be a separate owned regular file');
    return await fs.readFile(file);
  } catch (e) { if (e.code === 'ENOENT') return null; throw e; }
}
async function replace(file, bytes) {
  const temp = path.join(path.dirname(file), '.agentx-sidecar-'+require('node:crypto').randomUUID()+'.tmp');
  try {
    const handle = await fs.open(temp, 'wx', 0o600);
    try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
    await fs.rename(temp, file); await syncDir(path.dirname(file));
  } finally { await fs.rm(temp, { force: true }); }
}
function createPhotoProjectionTags({ root, directory, library, existing }) {
  return async function syncTags(input) {
    const writeId = id(input.writeId), revision = input.revision;
    if (!Number.isSafeInteger(revision) || revision < 0) throw fail('INVALID_PHOTO_TAGS', 'Expected a review revision');
    const projection = await existing(input.sha256);
    if (!projection) throw fail('PROJECTION_REQUIRED', 'Project verified media before writing gallery tags');
    const value = { sha256: projection.sha256, relativePath: projection.relativePath, writeId, revision, tags: tagList(input.tags) };
    const parent = await safeDirectory(root, '.agentx-import/gallery-sidecars/'+projection.sha256);
    const writes = await safeDirectory(parent, 'writes'), lock = path.join(parent, 'lock');
    try { await fs.mkdir(lock); } catch (e) {
      if (e.code === 'EEXIST') throw fail('PHOTO_TAGS_HELD', 'Observe the original gallery tag writer before retrying');
      throw e;
    }
    try {
      const target = path.join(directory, projection.relativePath+'.xmp');
      await safeDirectory(directory, path.dirname(projection.relativePath));
      const current = await optional(path.join(parent, 'current.json'));
      const priorIntent = await optional(path.join(writes, writeId, 'value.json'));
      if (priorIntent && hash(priorIntent) !== hash(value))
        throw fail('REQUEST_CONFLICT', 'This sidecar write identity has another tag decision');
      const bytes = await fileBytes(target), expected = Buffer.from(xmp(value));
      if (expected.length > 65536) throw fail('INVALID_PHOTO_TAGS', 'Encoded gallery tags exceed the XMP bound');
      if (bytes && (!current || digest(bytes) !== current.sidecarSha256)
        && (!priorIntent || hash(priorIntent) !== hash(value) || !bytes.equals(expected)))
        throw fail('PHOTO_SIDECAR_CONFLICT', 'An existing or edited gallery XMP is never overwritten');
      if (current && revision < current.revision)
        return { ...current, superseded: true };
      if (current && revision === current.revision && current.writeId !== writeId)
        throw fail('PHOTO_TAGS_CHANGED', 'Another tag decision owns this review revision');
      await library.immutable(writes, writeId, value);
      if (!bytes?.equals(expected)) await replace(target, expected);
      const state = { ...value, sidecarSha256: digest(expected) };
      await replace(path.join(parent, 'current.json'), Buffer.from(JSON.stringify(state)+'\n'));
      if (!(await fileBytes(target))?.equals(expected)) throw fail('PHOTO_SIDECAR_CONFLICT', 'Gallery sidecar readback differs');
      return { ...state, persisted: true };
    } finally { await fs.rmdir(lock); }
  };
}
module.exports = { createPhotoProjectionTags, tagList, xmp };
