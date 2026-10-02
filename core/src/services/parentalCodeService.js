'use strict';

const crypto = require('node:crypto');
const { timingSafeMatch } = require('./accessSessionService');

const SUBJECT = 'default';
const PARAMS = { N: 16384, r: 8, p: 1 };
const KEY_LENGTH = 32;
const MIN_LENGTH = 4;
const MAX_LENGTH = 128;

// Same shape the unlock form accepts: up to 128 characters, no control characters.
function codeProblem(code) {
  if (typeof code !== 'string' || code.length < MIN_LENGTH || code.length > MAX_LENGTH) {
    return `Le code parental doit contenir de ${MIN_LENGTH} à ${MAX_LENGTH} caractères.`;
  }
  if (/[\u0000-\u001f\u007f]/.test(code)) return 'Le code parental contient un caractère non permis.';
  return null;
}

function numericLength(code) {
  return /^[0-9]{1,128}$/.test(code) ? code.length : null;
}

function derive(code, salt, { N, r, p }) {
  return crypto.scryptSync(String(code), Buffer.from(salt, 'base64'), KEY_LENGTH, { N, r, p });
}

function hashCode(code) {
  const salt = crypto.randomBytes(16).toString('base64');
  return { salt, hash: derive(code, salt, PARAMS).toString('base64'), ...PARAMS, numericLength: numericLength(code) };
}

function matchesHash(record, code) {
  if (!record || typeof code !== 'string' || !code || code.length > MAX_LENGTH) return false;
  const expected = Buffer.from(record.hash, 'base64');
  const actual = derive(code, record.salt, record);
  return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
}

function mongoCodeStore() {
  const ParentalCode = require('../../models/ParentalCode');
  const fields = ({ salt, hash, N, r, p, numericLength: digits }) => ({ salt, hash, N, r, p, numericLength: digits });
  return {
    load: async () => {
      const record = await ParentalCode.findOne({ subject: SUBJECT }).lean();
      return record ? fields(record) : null;
    },
    // False when a code already exists: the first-run setup happens once.
    create: async record => {
      try {
        const result = await ParentalCode.updateOne({ subject: SUBJECT }, { $setOnInsert: record }, { upsert: true });
        return result.upsertedCount === 1;
      } catch (error) { if (error?.code === 11000) return false; throw error; }
    },
    replace: record => ParentalCode.updateOne({ subject: SUBJECT }, { $set: record })
  };
}

// The active parental code: AGENTX_PARENTAL_CODE when configured, otherwise
// the hash stored from the host. Verification is synchronous against the
// loaded record so the existing session service keeps its shape.
function createParentalCode({ envCode = '', store } = {}) {
  const backend = store || (envCode ? null : mongoCodeStore());
  let record = null;
  let loaded = Boolean(envCode);
  let loading = null;
  const code = {
    managedByConfig: Boolean(envCode),
    async load() {
      if (loaded) return;
      loading ||= backend.load().then(found => { record = found; loaded = true; }).finally(() => { loading = null; });
      await loading;
    },
    configured: () => Boolean(envCode || record),
    numericLength: () => (envCode ? numericLength(envCode) : record?.numericLength ?? null),
    verify: candidate => (envCode ? timingSafeMatch(envCode, candidate) : matchesHash(record, candidate)),
    async create(candidate) {
      const next = hashCode(candidate);
      if (!(await backend.create(next))) {
        loaded = false;
        await code.load();
        return false;
      }
      record = next;
      return true;
    },
    async replace(candidate) {
      const next = hashCode(candidate);
      await backend.replace(next);
      record = next;
    }
  };
  return code;
}

module.exports = { createParentalCode, codeProblem, hashCode, matchesHash, MIN_LENGTH, MAX_LENGTH };
