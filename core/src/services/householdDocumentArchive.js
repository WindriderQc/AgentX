'use strict';

// Explicit private exports only. This is a read-only intake adapter, not an
// ingestion root, filesystem scanner or another corpus owner.
const fs = require('node:fs/promises');
const { constants } = require('node:fs');
const path = require('node:path');
const { sha256, decodeText } = require('../helpers/fileContentChecks');
const { memoryClassification } = require('../../../shared/memoryClassification');
const { memoryFactInput, memoryValidityInput } = require('../../../shared/memoryFactMetadata');
const MAX_BYTES = 1024 * 1024;
const fail = (message, statusCode = 400, code = 'HOUSEHOLD_DOCUMENT_INVALID') => Object.assign(new Error(message), { statusCode, code });
const fingerprint = value => sha256(Buffer.from(JSON.stringify(value)));
const same = (a, b) => ['dev', 'ino', 'size', 'mtimeMs', 'ctimeMs'].every(key => a[key] === b[key]);
const idPattern = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/;
function relative(value) {
  if (typeof value !== 'string' || !value || value.length > 500 || /[\\\x00-\x1f\x7f]/.test(value)
    || path.isAbsolute(value) || value.split('/').some(part => !part || part === '.' || part === '..')) throw fail('Chemin relatif sans traversée requis.');
  return value;
}
function normalize(config) {
  if (config?.schemaVersion !== 1 || typeof config.archiveId !== 'string' || !idPattern.test(config.archiveId)
    || typeof config.root !== 'string' || !path.isAbsolute(config.root)
    || !Array.isArray(config.documents) || config.documents.length > 100) throw fail('Configuration des candidats invalide.');
  const seen = new Set();
  const documents = config.documents.map(entry => {
    if (typeof entry?.id !== 'string' || !idPattern.test(entry.id) || seen.has(entry.id)) throw fail('Identifiant de document invalide ou dupliqué.');
    seen.add(entry.id);
    const relativePath = relative(entry.relativePath);
    if (!['.md', '.txt'].includes(path.extname(relativePath).toLowerCase())) throw fail('Exports UTF-8 Markdown ou texte uniquement.');
    const classification = memoryClassification(entry);
    if (!classification.scope) throw fail('Classification explicite requise.');
    if (typeof entry.title !== 'string' || !entry.title.trim() || entry.title.length > 160) throw fail('Titre requis (160 caractères maximum).');
    const fact = memoryFactInput(entry), validity = memoryValidityInput(entry);
    const expiresAt = memoryValidityInput({ invalidatedAt: entry.expiresAt ?? null }).invalidatedAt;
    if (fact.validFrom && [expiresAt, validity.invalidatedAt].some(date => date && date < fact.validFrom)) throw fail('La fin de validité précède la date du document.');
    if (validity.supersededBy && !validity.invalidatedAt) throw fail('Un remplacement exige une date de fin de validité.');
    if (entry.tags !== undefined && (!Array.isArray(entry.tags) || entry.tags.length > 20
      || entry.tags.some(tag => typeof tag !== 'string' || !tag.trim() || tag.length > 80))) throw fail('Étiquettes invalides.');
    return { id: entry.id, title: entry.title.trim(), relativePath, ...classification,
      validFrom: fact.validFrom ?? null, sourceRefs: fact.sourceRefs || [],
      invalidatedAt: validity.invalidatedAt ?? null, supersededBy: validity.supersededBy ?? null,
      expiresAt, tags: entry.tags || [] };
  });
  return { schemaVersion: 1, archiveId: config.archiveId, root: config.root, documents };
}
function createDocumentArchive({ env = process.env, configPath } = {}) {
  const location = () => configPath || path.join(env.AGENTX_INSTANCE_ROOT || '/etc/agentx', 'config/household-document-candidates.json');
  async function configuration() {
    let handle;
    try {
      handle = await fs.open(location(), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      const stat = await handle.stat();
      if (!stat.isFile() || stat.size > MAX_BYTES) throw fail('Configuration invalide.');
      const bytes = Buffer.alloc(stat.size + 1);
      const result = await handle.read(bytes, 0, bytes.length, 0);
      if (result.bytesRead !== stat.size || !same(stat, await handle.stat())) throw fail('Configuration modifiée pendant la lecture.', 409);
      return normalize(JSON.parse(bytes.subarray(0, stat.size).toString('utf8')));
    } catch (error) {
      if (error.code === 'ENOENT' && !handle) return null;
      throw error.statusCode ? error : fail('Configuration des candidats indisponible ou invalide.', 503, 'HOUSEHOLD_DOCUMENT_UNAVAILABLE');
    } finally { await handle?.close(); }
  }
  async function list({ offset = 0 } = {}) {
    const page = Number(offset);
    if (!Number.isInteger(page) || page < 0 || page > 100) throw fail('Page invalide.');
    const config = await configuration();
    if (!config) return { configured: false, entries: [], nextOffset: null, total: 0 };
    return { configured: true, total: config.documents.length,
      entries: config.documents.slice(page, page + 20).map(({ relativePath: _path, ...entry }) => ({ ...entry, archiveId: config.archiveId })),
      nextOffset: page + 20 < config.documents.length ? page + 20 : null };
  }
  async function read(id) {
    if (typeof id !== 'string' || !idPattern.test(id)) throw fail('Identifiant invalide.');
    const config = await configuration();
    if (!config) throw fail('Aucune archive de candidats configurée.', 503, 'HOUSEHOLD_DOCUMENT_DISABLED');
    const entry = config.documents.find(doc => doc.id === id);
    if (!entry) throw fail('Document absent de la configuration.', 404);
    let handle;
    try {
      const root = await fs.realpath(config.root);
      let file = root;
      const components = [];
      for (const part of entry.relativePath.split('/')) {
        file = path.join(file, part);
        const stat = await fs.lstat(file);
        if (stat.isSymbolicLink()) throw fail('Les liens symboliques ne sont pas acceptés.');
        components.push({ file, stat });
      }
      const stat = components.at(-1).stat;
      if (!stat.isFile() || stat.size < 1 || stat.size > MAX_BYTES) throw fail('Export texte de 1 octet à 1 Mo requis.', 413);
      handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      if (!same(stat, await handle.stat())) throw fail('Le document a changé.', 409);
      const bytes = Buffer.alloc(stat.size + 1);
      let length = 0;
      while (length < bytes.length) {
        const result = await handle.read(bytes, length, bytes.length - length, length);
        if (!result.bytesRead) break;
        length += result.bytesRead;
      }
      if (length !== stat.size || !same(stat, await handle.stat())) throw fail('Le document a changé.', 409);
      for (const item of components) {
        const current = await fs.lstat(item.file);
        if (current.isSymbolicLink() || current.dev !== item.stat.dev || current.ino !== item.stat.ino) throw fail('Le chemin a changé.', 409);
      }
      if (await fs.realpath(config.root) !== root || !same(stat, await fs.lstat(file))) throw fail('L’archive a changé.', 409);
      const raw = bytes.subarray(0, length), decoded = decodeText(raw);
      if (decoded.error || !decoded.text.trim()) throw fail('Le document doit contenir du texte UTF-8 lisible.');
      // Keep the configured provenance privately. Only opaque review IDs need
      // travel with any later approved derivative in RAG.
      const origin = { archiveId: config.archiveId, root: config.root, ...entry, sha256: sha256(raw), size: length };
      return { origin, text: decoded.text, revision: fingerprint({ origin, text: decoded.text }) };
    } catch (error) {
      throw error.statusCode ? error : fail('Original indisponible. Aucun remplacement automatique.', 409, 'HOUSEHOLD_DOCUMENT_SOURCE_UNAVAILABLE');
    } finally { await handle?.close(); }
  }
  return { list, read };
}
module.exports = { createDocumentArchive, normalize, fingerprint, fail, MAX_BYTES };
