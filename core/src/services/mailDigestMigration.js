'use strict';

const MemoryNote = require('../../models/MemoryNote');
const journal = require('./mailJournalService');

// Moves mail digests that were saved as personal notes into the mail journal.
// A note is a digest when it carries a Gmail thread/message id; a note that
// reads like one without an id is reported for review and left alone.
// Gmail ids are 16 lowercase hex digits with at least one letter: a 16-digit
// card or account number is not a thread id.
const GMAIL_ID = /\b(?=[0-9]*[a-f])[0-9a-f]{16}\b/;
const MAIL_WORDS = /courriel|e-?mail|\bfil\b|pi[eè]ce jointe|facture|\bpdf\b|talon|lettre|gmail/i;
const MIGRATION_SOURCE = 'notes-migration';

function classify(note) {
  const text = String(note.text || '');
  const threadId = text.match(GMAIL_ID)?.[0];
  if (threadId) return { kind: 'digest', threadId };
  if (MAIL_WORDS.test(text) && text.length > 200) return { kind: 'review' };
  return { kind: 'fact' };
}

const personalFilter = { packId: 'personal_operator', scopeId: 'personal', status: { $ne: 'forgotten' } };
const preview = text => String(text).split(/\s+/).slice(0, 8).join(' ');

// Raw collection reads: legacy rows may carry ids or fields the model would
// refuse to cast, and one odd row must not stop the migration.
const personalNotes = () => MemoryNote.collection.find(personalFilter).sort({ createdAt: 1 }).toArray();

async function planMigration() {
  const notes = await personalNotes();
  const rows = notes.map(note => ({ id: String(note._id), createdAt: note.createdAt, source: note.source,
    length: String(note.text || '').length, preview: preview(note.text || ''), ...classify(note) }));
  const count = kind => rows.filter(row => row.kind === kind).length;
  return { total: rows.length, digests: count('digest'), review: count('review'), facts: count('fact'), rows };
}

// Each digest becomes its own journal entry (message key = note id, so notes
// about one thread do not overwrite each other), dated by when it was filed.
// The note is then forgotten (hidden from every reader), not deleted; the
// CLI's backup is the way back.
const filedAt = (note, now) => note.createdAt || note.updatedAt
  || (typeof note._id?.getTimestamp === 'function' ? note._id.getTimestamp() : now);
// The notes a run would move, read before anything changes (the CLI backup).
async function digestNotes(ids) {
  const wanted = ids ? new Set(ids) : null;
  return (await personalNotes()).filter(note => classify(note).kind === 'digest'
    && (!wanted || wanted.has(String(note._id))));
}

async function applyMigration({ ids, now = new Date() } = {}) {
  const backup = await digestNotes(ids);
  const moved = [], skipped = [];
  for (const note of backup) {
    const row = { id: String(note._id), threadId: classify(note).threadId };
    let receipt;
    try {
      receipt = await journal.record({ threadId: row.threadId, messageId: `note:${row.id}`,
        occurredAt: filedAt(note, now), summary: note.text.slice(0, 4000), tags: ['migrated-from-notes'],
        source: MIGRATION_SOURCE, sensitivity: note.sensitivity === 'highly_private' ? 'highly_private' : 'private' }, { now });
    } catch (err) {
      // One unreadable note must not stop the others; it stays a note.
      skipped.push({ id: row.id, reason: err.message });
      continue;
    }
    if (!receipt.recorded) { skipped.push({ id: row.id, reason: receipt.reason }); continue; }
    await MemoryNote.collection.updateOne({ _id: note._id, status: { $ne: 'forgotten' } },
      { $set: { status: 'forgotten', forgottenAt: now } });
    moved.push({ id: row.id, entryId: receipt.entry.id });
  }
  return { moved, skipped, backup };
}

module.exports = { classify, planMigration, digestNotes, applyMigration, MIGRATION_SOURCE };
