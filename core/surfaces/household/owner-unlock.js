'use strict';

// Owner unlock of a device pinned to the family profile (#826, part 2).
//
// On a pinned tablet the owner says "Nestor superDad" followed by a secret
// phrase. Core hears it in its own speech-recognition proxy, from the audio
// the tablet sent, never from typed text: a transcript that starts with the
// trigger is swallowed (the page receives empty text, so neither the phrase
// nor the attempt reaches a conversation). The phrase is compared with a
// scrypt hash from the instance environment (HOUSEHOLD_OWNER_UNLOCK_PHRASE_HASH,
// outside Git). A match opens full owner access on that device for a few
// minutes (HOUSEHOLD_OWNER_UNLOCK_MINUTES, default 10), as a server record
// bound to the device's pin token. It ends at its time or with Relock.
//
// Limit: this proves knowledge of the phrase, not the owner's voice. Speaker
// identification remains the open half of #826 (docs/VOICE_ID.md).

const crypto = require('crypto');

const TRIGGER = 'nestorsuperdad';
const WAKE_WORDS = new Set(['hey', 'eille', 'he', 'oh', 'ah', 'ok', 'okay', 'dis', 'salut', 'bonjour']);
const SCRYPT = { N: 16384, r: 8, p: 1, keyLength: 32 };
const DEFAULT_MINUTES = 10;
const AUDIT_TTL_SECONDS = 90 * 24 * 60 * 60;
const REFUSAL_AUDIT_EVERY_MS = 60 * 1000;

/** Lower case, no accents or punctuation, single spaces: what recognition varies on. */
function normalizeSpeech(text) {
  return String(text || '').normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ').trim();
}

const compact = (text) => normalizeSpeech(text).replace(/ /g, '');

/** The phrase after "Nestor superDad" (however it was spelled), or null. */
function splitTrigger(text) {
  const tokens = normalizeSpeech(text).split(' ').filter(Boolean);
  const start = WAKE_WORDS.has(tokens[0]) ? 1 : 0;
  for (let length = 1; length <= 4 && start + length <= tokens.length; length += 1) {
    if (tokens.slice(start, start + length).join('') === TRIGGER) return { phrase: tokens.slice(start + length).join(' ') };
  }
  return null;
}

function derive(phrase, salt, { N, r, p, keyLength }) {
  return crypto.scryptSync(compact(phrase), salt, keyLength, { N, r, p, maxmem: 64 * 1024 * 1024 });
}

/** `scrypt$N$r$p$salt$key` for the instance environment; the phrase itself is never stored. */
function hashPhrase(phrase, salt = crypto.randomBytes(16)) {
  if (!compact(phrase)) throw new Error('The unlock phrase is empty');
  const key = derive(phrase, salt, SCRYPT);
  return ['scrypt', SCRYPT.N, SCRYPT.r, SCRYPT.p, salt.toString('base64url'), key.toString('base64url')].join('$');
}

function verifyPhrase(phrase, stored) {
  const parts = String(stored || '').split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt' || !compact(phrase)) return false;
  const [N, r, p] = parts.slice(1, 4).map(Number);
  if (![N, r, p].every(Number.isSafeInteger) || N > 1 << 20) return false;
  const expected = Buffer.from(parts[5], 'base64url');
  if (expected.length < 16) return false;
  const actual = derive(phrase, Buffer.from(parts[4], 'base64url'), { N, r, p, keyLength: expected.length });
  return crypto.timingSafeEqual(actual, expected);
}

function unlockMinutes(env) {
  const minutes = Number(env.HOUSEHOLD_OWNER_UNLOCK_MINUTES);
  return Number.isInteger(minutes) && minutes >= 1 && minutes <= 60 ? minutes : DEFAULT_MINUTES;
}

function createModels(mongoose) {
  const unlockName = 'AgentXHouseholdOwnerUnlock';
  const auditName = 'AgentXHouseholdOwnerUnlockAudit';
  const Unlock = mongoose.models[unlockName] || mongoose.model(unlockName, new mongoose.Schema({
    tokenHash: { type: String, required: true, unique: true },
    label: { type: String, default: 'Family device' },
    unlockedAt: { type: Date, required: true },
    until: { type: Date, required: true, index: { expireAfterSeconds: 0 } }
  }), 'household_owner_unlocks');
  // No phrase, transcript or audio: who (which device), when and what happened.
  const Audit = mongoose.models[auditName] || mongoose.model(auditName, new mongoose.Schema({
    at: { type: Date, required: true, index: { expireAfterSeconds: AUDIT_TTL_SECONDS } },
    label: { type: String, default: 'Family device' },
    outcome: { type: String, enum: ['unlocked', 'refused', 'not-configured', 'relocked', 'unavailable'], required: true },
    until: { type: Date, default: null }
  }), 'household_owner_unlock_audit');
  return { Unlock, Audit };
}

function createOwnerUnlock({ mongoose, logger, env = process.env, now = () => new Date(), alerts = require('../../models/Alert') }) {
  const { Unlock, Audit } = createModels(mongoose);
  const lastRefusal = new Map();

  async function audit(label, outcome, until = null) {
    try { await Audit.create({ at: now(), label, outcome, until }); }
    catch (error) { logger?.warn?.('Owner unlock audit not written', { outcome, error: error.message }); }
  }

  async function alertUnlocked(label, until) {
    const at = now();
    const fingerprint = `owner-unlock:${label}:${at.toISOString()}`;
    try {
      await alerts.create({
        _id: crypto.createHash('sha256').update(fingerprint).digest('hex').slice(0, 24),
        ruleId: 'household_owner_unlock', ruleName: 'Owner unlock on a family device', fingerprint,
        severity: 'info', status: 'active', title: `Full access opened on ${label}`,
        message: `"Nestor superDad" unlocked ${label} until ${until.toISOString()}.`,
        context: { component: 'household-family-device', additionalData: { label, until, path: '/panel' } },
        channels: [], firstOccurrence: at, lastOccurrence: at
      });
    } catch (error) { logger?.warn?.('Owner unlock alert not written', { error: error.message }); }
  }

  /** When this device's unlock ends, or null. A store error throws: the caller keeps the device locked. */
  async function activeUntil(tokenHash) {
    const row = await Unlock.findOne({ tokenHash, until: { $gt: now() } }, { until: 1 }).lean();
    return row ? row.until : null;
  }

  /**
   * Called with every transcript the speech proxy returns. A transcript that
   * starts with the trigger is replaced by empty text; on a pinned device whose
   * phrase matches, it also opens the unlock. Anything else passes unchanged.
   */
  async function intercept(req, result, { tokenHash } = {}) {
    const trigger = splitTrigger(result?.text);
    if (!trigger) return null;
    const reply = { text: '', control: 'owner_unlock' };
    const device = req.familyDevice;
    if (!device || device.unverified || !tokenHash) return reply;
    const label = device.label || 'Family device';
    const stored = env.HOUSEHOLD_OWNER_UNLOCK_PHRASE_HASH;
    if (!stored) { await audit(label, 'not-configured'); return reply; }
    if (!verifyPhrase(trigger.phrase, stored)) {
      // Recognition of a phrase still being spoken repeats; one line a minute is enough.
      const at = now().getTime();
      if (!(lastRefusal.get(tokenHash) > at - REFUSAL_AUDIT_EVERY_MS)) {
        lastRefusal.set(tokenHash, at);
        await audit(label, 'refused');
      }
      return reply;
    }
    const until = new Date(now().getTime() + unlockMinutes(env) * 60000);
    try {
      await Unlock.updateOne({ tokenHash }, { $set: { label, unlockedAt: now(), until } }, { upsert: true });
    } catch (error) {
      logger?.warn?.('Owner unlock not recorded; the device stays locked', { error: error.message });
      await audit(label, 'unavailable');
      return reply;
    }
    await audit(label, 'unlocked', until);
    await alertUnlocked(label, until);
    logger?.info?.('Owner unlock opened on a family device', { label, until });
    return { ...reply, unlocked: true, until: until.toISOString() };
  }

  async function relock(tokenHash, label = 'Family device') {
    const { deletedCount } = await Unlock.deleteOne({ tokenHash });
    if (deletedCount) await audit(label, 'relocked');
    return deletedCount > 0;
  }

  return { activeUntil, intercept, relock, forget: (tokenHash) => Unlock.deleteMany({ tokenHash }) };
}

module.exports = { createOwnerUnlock, hashPhrase, verifyPhrase, splitTrigger, normalizeSpeech, unlockMinutes };
