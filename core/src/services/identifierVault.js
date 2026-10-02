'use strict';

const { createCipheriv, createDecipheriv, createHmac, randomBytes } = require('node:crypto');
const IdentifierVaultEntry = require('../../models/IdentifierVaultEntry');

// Sensitive identifiers found in text Nestor stores (memory notes, mail
// journal) are moved into an encrypted vault and replaced by a reference.
// Detection is anchored on the identifier's name, plus card numbers that pass
// the Luhn check. Without IDENTIFIER_VAULT_KEY the text is stored unchanged.
const PATTERNS = [
  { kind: 'niq', label: 'NIQ', re: /\b(NIQ)\b([^0-9\n]{0,30})(\d{10})\b/gi },
  { kind: 'nas', label: 'NAS', re: /\b(NAS|num[ée]ro d['’]assurance sociale|SIN)\b([^0-9\n]{0,30})(\d{3}[ -]?\d{3}[ -]?\d{3})\b/gi },
  { kind: 'reee', label: 'REEE', re: /\b(REEE|RESP)\b([^0-9\n]{0,40})(\d[\d-]{4,}\d)\b/gi },
  { kind: 'account', label: 'compte', re: /\b(compte|folio|account)\b([^0-9\n]{0,25})(\d[\d -]{4,}\d)\b/gi },
];
const CARD = /\b(?:\d[ -]?){12,18}\d\b/g;
const DATE = /^\d{4}-\d{2}-\d{2}$|^\d{2}-\d{2}-\d{4}$/;

function vaultKey(env = process.env) {
  const raw = String(env.IDENTIFIER_VAULT_KEY || '').trim();
  if (!raw) return null;
  const key = Buffer.from(raw, 'base64');
  if (key.length !== 32) throw Object.assign(new Error('IDENTIFIER_VAULT_KEY must be 32 bytes in base64'), { code: 'IDENTIFIER_VAULT_KEY_INVALID' });
  return key;
}

const digitsOf = value => value.replace(/[^0-9A-Za-z]/g, '').toUpperCase();
function luhn(digits) {
  let sum = 0;
  for (let i = 0; i < digits.length; i += 1) {
    let n = Number(digits[digits.length - 1 - i]);
    if (i % 2) { n *= 2; if (n > 9) n -= 9; }
    sum += n;
  }
  return sum % 10 === 0;
}

// A match must also look like the identifier it names: a NAS passes Luhn, an
// account number has 7 to 20 digits and is not a date.
function plausible(kind, value) {
  const digits = value.replace(/[^0-9]/g, '');
  if (kind === 'nas') return luhn(digits);
  if (kind === 'account') return digits.length >= 7 && digits.length <= 20 && !DATE.test(value.trim());
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
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(body), decipher.final()]).toString('utf8');
}

// Finds identifiers in text: [{ kind, label, value, start, end }] (value only).
function findIdentifiers(text) {
  const found = [];
  for (const { kind, label, re } of PATTERNS) {
    for (const match of String(text).matchAll(re)) {
      const value = match[3].trim();
      if (!plausible(kind, value)) continue;
      const start = match.index + match[1].length + match[2].length;
      found.push({ kind, label, value, start, end: start + value.length });
    }
  }
  for (const match of String(text).matchAll(CARD)) {
    const digits = digitsOf(match[0]);
    if (digits.length >= 13 && luhn(digits) && !found.some(f => match.index < f.end && f.start < match.index + match[0].length)) {
      found.push({ kind: 'card', label: 'carte', value: match[0], start: match.index, end: match.index + match[0].length });
    }
  }
  return found.sort((a, b) => a.start - b.start)
    .filter((f, i, all) => i === 0 || f.start >= all[i - 1].end);
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
  if (!key) throw Object.assign(new Error('The identifier vault is not configured'), { statusCode: 503, code: 'IDENTIFIER_VAULT_NOT_CONFIGURED' });
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
