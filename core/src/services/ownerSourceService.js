'use strict';

// Sources the owner's history can cite besides archived mail, each held by
// Core or by a read-only household mount, never copied:
//   owner-statement  the owner's own words, kept in Core (OwnerStatement)
//   core-record      a record Core already holds: a finance ledger line or a
//                    message in a conversation
//   owner-file       a household file: a photo or photo folder, or a document
//                    in the owner's Datalake, by root and relative path
// Every reference carries a SHA-256 identity: the statement text, the record
// locator, the file content, or the folder locator.

const { createHash } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const MAIL_SYSTEMS = ['gmail', 'outlook-export'];
const OWNER_SYSTEMS = ['owner-statement', 'core-record', 'owner-file'];
const SYSTEMS = [...MAIL_SYSTEMS, ...OWNER_SYSTEMS];
const HASH = /^[a-f0-9]{64}$/;
const RECORD = /^(?:finance_transactions\/[a-f0-9]{24}|conversations\/[a-f0-9]{24}\/messages\/[a-f0-9]{24})$/;
const FILE = /^(photos|documents):([^\0]{1,480})$/;
const IMAGE_TYPES = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.gif': 'image/gif', '.webp': 'image/webp', '.heic': 'image/heic' };
const FILE_TYPES = { ...IMAGE_TYPES, '.pdf': 'application/pdf', '.txt': 'text/plain; charset=utf-8',
  '.doc': 'application/msword', '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xls': 'application/vnd.ms-excel', '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' };
const INLINE = new Set([...Object.values(IMAGE_TYPES), 'application/pdf', 'text/plain; charset=utf-8']);
const FOLDER_LIMIT = 60;
const MAX_FILE_BYTES = 200 * 1024 * 1024;

const digest = value => createHash('sha256').update(value).digest('hex');
const failure = (message, statusCode = 400, code = 'OWNER_SOURCE_INVALID') => Object.assign(new Error(message), { statusCode, code });

// Where each file root is mounted in the Core container (read-only).
function roots(env = process.env) {
  return {
    photos: path.resolve(env.OWNER_PHOTOS_DIR || path.join(env.HOUSEHOLD_IMAGE_MOUNT_BASE || '/mnt/household', 'photos')),
    documents: path.resolve(env.OWNER_DOCUMENTS_MOUNT || '/mnt/owner/documents')
  };
}

// Validates a cited source and returns its system and locator.
function validate(source = {}) {
  if (!SYSTEMS.includes(source.system)) throw failure(`Choose ${SYSTEMS.join(', ')}`);
  for (const key of ['sourceSha256', 'findingId']) if (!HASH.test(source[key] || '')) throw failure(`source.${key} must be a SHA-256`);
  const locator = typeof source.locator === 'string' ? source.locator.trim() : '';
  if (source.system === 'core-record') {
    if (!RECORD.test(locator)) throw failure('A Core record is a finance line or a conversation message');
    if (digest(`core-record:${locator}`) !== source.sourceSha256) throw failure('A Core record is identified by the hash of its locator');
  } else if (source.system === 'owner-file') {
    const match = FILE.exec(locator);
    if (!match || match[2].startsWith('/') || match[2].split('/').includes('..')) throw failure('A household file is photos:<path> or documents:<path>');
  } else if (locator) throw failure('Only Core records and household files carry a locator');
  return { system: source.system, locator };
}

// The real path behind a file locator, only inside its mounted root.
function resolveFile(locator, env = process.env) {
  const match = FILE.exec(locator || '');
  if (!match) return null;
  const root = roots(env)[match[1]];
  try {
    const realRoot = fs.realpathSync(root);
    const target = fs.realpathSync(path.join(root, match[2]));
    if (target !== realRoot && !target.startsWith(realRoot + path.sep)) return null;
    return { root: match[1], relative: match[2], target, stat: fs.statSync(target) };
  } catch { return null; }
}

// A file's hash is reused while its size and modification time are unchanged,
// so a photo shown again is not read in full again.
const hashes = new Map();
const HASH_CACHE_LIMIT = 5000;
async function hashFile(file) {
  const stat = fs.statSync(file), key = `${file}\0${stat.size}\0${stat.mtimeMs}`;
  if (hashes.has(key)) return hashes.get(key);
  const value = await readHash(file);
  if (hashes.size >= HASH_CACHE_LIMIT) hashes.delete(hashes.keys().next().value);
  hashes.set(key, value);
  return value;
}

function readHash(file) {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    fs.createReadStream(file).on('error', reject).on('data', chunk => hash.update(chunk)).on('end', () => resolve(hash.digest('hex')));
  });
}

// A file or folder whose identity still matches what was cited, or null.
async function verifiedFile(locator, sha256, env = process.env) {
  const found = resolveFile(locator, env);
  if (!found || !HASH.test(sha256 || '')) return null;
  if (found.stat.isDirectory()) return digest(`owner-file:${locator}`) === sha256 ? { ...found, folder: true } : null;
  if (!found.stat.isFile() || found.stat.size > MAX_FILE_BYTES) return null;
  return await hashFile(found.target) === sha256 ? { ...found, folder: false } : null;
}

const fileUrl = (locator, sha256) => `/api/secretary/sources/file?locator=${encodeURIComponent(locator)}&sha256=${sha256}`;

function createOwnerSources({ models = {}, env = process.env, seal } = {}) {
  const Statement = () => models.OwnerStatement || require('../../models/OwnerStatement');
  const Transaction = () => models.FinanceTransaction || require('../../models/FinanceTransaction');
  const FinanceStatement = () => models.FinanceStatement || require('../../models/FinanceStatement');
  const Conversation = () => models.Conversation || require('../../models/Conversation');
  const sealText = seal || (async value => (await require('./identifierVault').sealText(value, { seenIn: 'owner-statement' })).text);

  // The owner's statements, idempotent by the hash of the words as given.
  async function keepStatements(inputs) {
    if (!Array.isArray(inputs) || !inputs.length || inputs.length > 50) throw failure('Keep 1-50 statements');
    const values = inputs.map(input => {
      const text = typeof input?.text === 'string' ? input.text.trim() : '';
      if (!text || text.length > 20000 || text.includes('\0')) throw failure('A statement holds 1-20000 characters');
      const label = typeof input.label === 'string' ? input.label.trim().slice(0, 200) : '';
      const receivedOn = /^\d{4}-\d{2}-\d{2}$/.test(input.receivedOn || '') ? input.receivedOn : '';
      if (input.chapter !== undefined && (typeof input.chapter !== 'object' || JSON.stringify(input.chapter).length > 50000)) throw failure('A chapter is a small JSON object');
      return { sha256: digest(text), text, label, receivedOn, chapter: input.chapter ?? null };
    });
    const results = [];
    for (const value of values) {
      const existing = await Statement().findOne({ sha256: value.sha256 }).lean();
      if (existing) { results.push({ sha256: value.sha256, created: false, status: existing.status }); continue; }
      await Statement().updateOne({ sha256: value.sha256 },
        { $setOnInsert: { ...value, text: await sealText(value.text), scope: 'owner', status: 'active' } }, { upsert: true });
      results.push({ sha256: value.sha256, created: true, status: 'active' });
    }
    return { authority: 'agentx.core', results };
  }

  async function statements() {
    const rows = await Statement().find({ scope: 'owner', status: 'active' }).sort({ receivedOn: 1, createdAt: 1 }).lean();
    return { authority: 'agentx.core', statements: rows.map(row => ({ sha256: row.sha256, label: row.label, receivedOn: row.receivedOn,
      text: row.text, chapter: row.chapter || null })) };
  }

  // What a cited source says, read from its owner. Mail stays with the archive reader.
  async function read({ system, locator = '', sha256 } = {}) {
    if (!OWNER_SYSTEMS.includes(system)) throw failure('Read mail through the archive reader');
    if (!HASH.test(sha256 || '')) throw failure('sha256 is required');
    if (system === 'owner-statement') {
      const row = await Statement().findOne({ sha256, scope: 'owner', status: 'active' }).lean();
      if (!row) throw failure('This statement is unavailable', 404, 'OWNER_SOURCE_UNAVAILABLE');
      return { authority: 'agentx.core', system, kind: 'testimony', title: row.label || 'Ton témoignage', date: row.receivedOn, text: row.text };
    }
    if (system === 'core-record') {
      validate({ system, locator, sourceSha256: sha256, findingId: sha256 });
      const [collection, id, , messageId] = locator.split('/');
      if (collection === 'finance_transactions') {
        const row = await Transaction().findById(id).lean();
        if (!row) throw failure('This ledger line is unavailable', 404, 'OWNER_SOURCE_UNAVAILABLE');
        const statement = row.statementId ? await FinanceStatement().findById(row.statementId).lean() : null;
        return { authority: 'agentx.core', system, kind: 'ledger', title: row.description, date: row.date,
          text: [`Date : ${row.date}`, `Libellé : ${row.description}`, `Montant : ${(row.amountCents / 100).toFixed(2)} $`,
            row.category ? `Catégorie : ${row.category}` : '', `Compte : ${row.accountKey}`].filter(Boolean).join('\n'),
          statement: statement ? { fileName: statement.fileName, issuer: statement.issuer, periodStart: statement.periodStart, periodEnd: statement.periodEnd } : null };
      }
      const conversation = await Conversation().findById(id).lean();
      const message = conversation?.messages?.find(item => String(item._id) === messageId);
      if (!message) throw failure('This conversation message is unavailable', 404, 'OWNER_SOURCE_UNAVAILABLE');
      return { authority: 'agentx.core', system, kind: 'conversation', title: conversation.title || 'Conversation',
        date: message.timestamp, text: String(message.content || '').slice(0, 20000), role: message.role };
    }
    validate({ system, locator, sourceSha256: sha256, findingId: sha256 });
    const found = await verifiedFile(locator, sha256, env);
    if (!found) throw failure('This file is unavailable or has changed since it was cited', 404, 'OWNER_SOURCE_UNAVAILABLE');
    const name = path.basename(found.relative);
    if (found.folder) {
      const images = fs.readdirSync(found.target, { withFileTypes: true })
        .filter(entry => entry.isFile() && IMAGE_TYPES[path.extname(entry.name).toLowerCase()])
        .map(entry => entry.name).sort().slice(0, FOLDER_LIMIT);
      return { authority: 'agentx.core', system, kind: 'folder', title: name, locator, modifiedAt: found.stat.mtime.toISOString(),
        images: images.map(file => ({ name: file, url: `/api/secretary/sources/folder-image?locator=${encodeURIComponent(locator)}&sha256=${sha256}&name=${encodeURIComponent(file)}` })) };
    }
    const type = FILE_TYPES[path.extname(name).toLowerCase()] || 'application/octet-stream';
    return { authority: 'agentx.core', system, kind: IMAGE_TYPES[path.extname(name).toLowerCase()] ? 'photo' : 'document', title: name, locator,
      bytes: found.stat.size, type, modifiedAt: found.stat.mtime.toISOString(), url: fileUrl(locator, sha256) };
  }

  // Streams a cited file whose content still matches its hash.
  async function sendFile(req, res) {
    const locator = String(req.query.locator || ''), sha256 = String(req.query.sha256 || '');
    const found = await verifiedFile(locator, sha256, env);
    if (!found || found.folder) return res.status(404).json({ status: 'error', code: 'OWNER_SOURCE_UNAVAILABLE', message: 'File unavailable' });
    return stream(res, found.target);
  }

  // An image inside a cited photo folder.
  async function sendFolderImage(req, res) {
    const locator = String(req.query.locator || ''), sha256 = String(req.query.sha256 || ''), name = String(req.query.name || '');
    const found = await verifiedFile(locator, sha256, env);
    if (!found?.folder || !name || name.includes('/') || name.includes('\0') || !IMAGE_TYPES[path.extname(name).toLowerCase()]) {
      return res.status(404).json({ status: 'error', code: 'OWNER_SOURCE_UNAVAILABLE', message: 'Image unavailable' });
    }
    const inside = resolveFile(`${locator}/${name}`, env);
    if (!inside?.stat.isFile()) return res.status(404).json({ status: 'error', code: 'OWNER_SOURCE_UNAVAILABLE', message: 'Image unavailable' });
    return stream(res, inside.target);
  }

  function stream(res, file) {
    const type = FILE_TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream';
    res.set({ 'Content-Type': type, 'Cache-Control': 'private, max-age=3600', 'X-Content-Type-Options': 'nosniff',
      'Content-Disposition': `${INLINE.has(type) ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(path.basename(file))}` });
    return fs.createReadStream(file).on('error', () => { if (!res.headersSent) res.status(404).end(); else res.destroy(); }).pipe(res);
  }

  return { keepStatements, statements, read, sendFile, sendFolderImage };
}

// A link the history list offers for each cited source.
function sourceLink(source) {
  if (!source) return null;
  if (source.system === 'gmail') return `/api/secretary/archive/${encodeURIComponent(source.messageId)}?sha256=${source.sourceSha256}`;
  if (!OWNER_SYSTEMS.includes(source.system)) return null;
  return `/api/secretary/sources/read?system=${source.system}&sha256=${source.sourceSha256}${source.locator ? `&locator=${encodeURIComponent(source.locator)}` : ''}`;
}

module.exports = { createOwnerSources, validate, sourceLink, resolveFile, verifiedFile, roots, digest, SYSTEMS, MAIL_SYSTEMS, OWNER_SYSTEMS, IMAGE_TYPES };
