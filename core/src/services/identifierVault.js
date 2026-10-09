'use strict';

const { createCipheriv, createDecipheriv, createHmac, randomBytes } = require('node:crypto');
const IdentifierVaultEntry = require('../../models/IdentifierVaultEntry');

// Sensitive identifiers found in text Nestor stores for the owner (memory
// notes, mail journal) are moved into an encrypted vault and replaced by a
// reference. Every pattern is anchored on the identifier's name, and the value
// must look like that identifier. Without IDENTIFIER_VAULT_KEY the text is
// stored unchanged.
const NOT_IN_WORD = '(?<![\\p{L}\\p{N}])';
const anchored = (names, gap, value) => new RegExp(`${NOT_IN_WORD}(${names})(?![\\p{L}])([^0-9\\n]{0,${gap}})(${value})(?![\\p{L}\\p{N}])`, 'giu');
const PATTERNS = [
  { kind: 'niq', label: 'NIQ', re: anchored('NIQ', 30, '\\d(?: ?\\d){9}') },
  { kind: 'nas', label: 'NAS', re: anchored("NAS|N\\.A\\.S\\.|SIN|assurance sociale", 30, '\\d{3}[ -]?\\d{3}[ -]?\\d{3}') },
  // Upper case only: "resp." is an abbreviation in French prose.
  { kind: 'reee', label: 'REEE', re: new RegExp(`${NOT_IN_WORD}(REEE|RESP)(?![\\p{L}])([^0-9\\n]{0,40})(\\d[\\d -]{4,}\\d)(?![\\p{L}\\p{N}])`, 'gu') },
  { kind: 'account', label: 'compte', re: anchored('comptes?|folio|account', 15, '\\d[\\d-]{5,18}\\d') },
  { kind: 'card', label: 'carte', re: anchored('cartes?|card|visa|mastercard|amex', 25, '\\d(?:[ -]?\\d){12,18}') },
];
const DATE = /^\d{4}-\d{2}-\d{2}$|^\d{2}-\d{2}-\d{4}$/;
const YEARS = /^(?:19|20)\d{2}(?:[ -]+(?:19|20)\d{2})*$/;
const PHONE = /^\d{3}-\d{3}-\d{4}$/;

function keyError(message, code) {
  return Object.assign(new Error(message), { statusCode: 503, code });
}

function vaultKey(env = process.env) {
  const raw = String(env.IDENTIFIER_VAULT_KEY || '').trim();
  if (!raw) return null;
  const key = Buffer.from(raw, 'base64');
  if (key.length !== 32) throw keyError('IDENTIFIER_VAULT_KEY must be 32 bytes in base64', 'IDENTIFIER_VAULT_KEY_INVALID');
  return key;
}

const digitsOf = value => value.replace(/[^0-9]/g, '');
function luhn(digits) {
  let sum = 0;
  for (let i = 0; i < digits.length; i += 1) {
    let n = Number(digits[digits.length - 1 - i]);
    if (i % 2) { n *= 2; if (n > 9) n -= 9; }
    sum += n;
  }
  return sum % 10 === 0;
}

// The value must look like the identifier its name announces.
function plausible(kind, value) {
  const digits = digitsOf(value);
  if (DATE.test(value) || YEARS.test(value) || PHONE.test(value)) return false;
  if (kind === 'nas') return luhn(digits);
  if (kind === 'card') return digits.length >= 13 && luhn(digits);
  if (kind === 'reee') return digits.length >= 6 && digits.length <= 20;
  if (kind === 'account') return digits.length >= 7 && digits.length <= 20;
  return true;
}

function encrypt(key, value) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const body = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  return [iv, cipher.getAuthTag(), body].map(part => part.toString('base64')).join('.');
}

function decrypt(key, sealed) {
  const [iv, tag, body] = sealed.split('.').map(part => Buffer.from(part, 'base64'));
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, iv, { authTagLength: 16 });
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(body), decipher.final()]).toString('utf8');
  } catch {
    throw keyError('This identifier was sealed with another IDENTIFIER_VAULT_KEY', 'IDENTIFIER_VAULT_KEY_MISMATCH');
  }
}

// Finds identifiers in text: [{ kind, label, value, start, end }]. When two
// matches overlap, the longer one wins.
function findIdentifiers(text) {
  const found = [];
  for (const { kind, label, re } of PATTERNS) {
    for (const match of String(text).matchAll(re)) {
      const value = match[3];
      if (!plausible(kind, value)) continue;
      const start = match.index + match[1].length + match[2].length;
      found.push({ kind, label, value, start, end: start + value.length });
    }
  }
  const kept = [];
  for (const item of found.sort((a, b) => a.start - b.start || (b.end - b.start) - (a.end - a.start))) {
    const last = kept[kept.length - 1];
    if (last && item.start < last.end) {
      if (item.end - item.start > last.end - last.start) kept[kept.length - 1] = item;
      continue;
    }
    kept.push(item);
  }
  return kept;
}

async function store(key, { kind, label, value }, seenIn) {
  const normalized = digitsOf(value);
  const fingerprint = createHmac('sha256', key).update(`${kind}:${normalized}`).digest('hex');
  const update = { $setOnInsert: { kind, label, sealed: encrypt(key, normalized), last4: normalized.slice(-4), fingerprint } };
  if (seenIn) update.$addToSet = { seenIn };
  try {
    return await IdentifierVaultEntry.findOneAndUpdate({ fingerprint }, update, { new: true, upsert: true });
  } catch (failure) {
    if (failure.code !== 11000) throw failure;
    return IdentifierVaultEntry.findOneAndUpdate({ fingerprint }, update, { new: true });
  }
}

// Returns the text with every identifier replaced by "[coffre: label …1234]".
async function sealText(text, { seenIn, env = process.env } = {}) {
  const key = vaultKey(env);
  if (!key || typeof text !== 'string' || !text) return { text, sealed: [] };
  const found = findIdentifiers(text);
  if (!found.length) return { text, sealed: [] };
  let out = '', cursor = 0;
  const sealed = [];
  for (const item of found) {
    const entry = await store(key, item, seenIn);
    out += `${text.slice(cursor, item.start)}[coffre: ${entry.label} …${entry.last4}]`;
    cursor = item.end;
    sealed.push({ id: String(entry._id), label: entry.label, kind: entry.kind });
  }
  return { text: out + text.slice(cursor), sealed };
}

const project = row => ({ id: String(row._id), label: row.label, kind: row.kind, last4: row.last4, createdAt: row.createdAt });

async function list() {
  return { ok: true, authority: 'agentx.core', configured: Boolean(vaultKey()),
    identifiers: (await IdentifierVaultEntry.find().sort({ createdAt: 1 }).lean()).map(project) };
}

async function reveal(id) {
  const key = vaultKey();
  if (!key) throw keyError('The identifier vault is not configured', 'IDENTIFIER_VAULT_NOT_CONFIGURED');
  if (typeof id !== 'string' || !/^[a-f0-9]{24}$/.test(id)) throw Object.assign(new Error('Choose an identifier id'), { statusCode: 400, code: 'IDENTIFIER_INVALID' });
  const row = await IdentifierVaultEntry.findById(id).lean();
  if (!row) throw Object.assign(new Error('Identifier not found'), { statusCode: 404, code: 'IDENTIFIER_NOT_FOUND' });
  return { ok: true, authority: 'agentx.core', ...project(row), value: decrypt(key, row.sealed) };
}

async function operate(input = {}) {
  const action = input.action;
  if (action === 'list') return { ...await list(), action };
  if (action === 'reveal') return { ...await reveal(input.id), action };
  throw Object.assign(new Error('Choose list or reveal'), { statusCode: 400, code: 'IDENTIFIER_INVALID' });
}

module.exports = { vaultKey, findIdentifiers, sealText, list, reveal, operate };
