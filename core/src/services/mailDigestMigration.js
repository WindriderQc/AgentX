'use strict';

const MemoryNote = require('../../models/MemoryNote');
const journal = require('./mailJournalService');

// Moves mail digests that were saved as personal notes into the mail journal.
// A note is a digest when it carries a Gmail thread/message id; a note that
// reads like one without an id is reported for review and left alone.
const GMAIL_ID = /\b[0-9a-f]{16}\b/;
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

async function planMigration() {
  const notes = await MemoryNote.find(personalFilter).sort({ createdAt: 1 }).lean();
  const rows = notes.map(note => ({ id: String(note._id), createdAt: note.createdAt, source: note.source,
    length: note.text.length, preview: preview(note.text), ...classify(note) }));
  const count = kind => rows.filter(row => row.kind === kind).length;
  return { total: rows.length, digests: count('digest'), review: count('review'), facts: count('fact'), rows };
}

// Each digest becomes its own journal entry (message key = note id, so notes
// about one thread do not overwrite each other), dated by when it was filed.
// The note is then forgotten, not deleted: it stays restorable until the
// memory retention sweep removes it.
async function applyMigration({ ids, now = new Date() } = {}) {
  const plan = await planMigration();
  const wanted = ids ? new Set(ids) : null;
  const digests = plan.rows.filter(row => row.kind === 'digest' && (!wanted || wanted.has(row.id)));
  const backup = await MemoryNote.find({ _id: { $in: digests.map(row => row.id) } }).lean();
  const moved = [], skipped = [];
  for (const note of backup) {
    const row = digests.find(entry => entry.id === String(note._id));
    const receipt = await journal.record({ threadId: row.threadId, messageId: `note:${row.id}`,
      occurredAt: note.createdAt, summary: note.text.slice(0, 4000), tags: ['migrated-from-notes'],
      source: MIGRATION_SOURCE, sensitivity: note.sensitivity === 'highly_private' ? 'highly_private' : 'private' }, { now });
    if (!receipt.recorded) { skipped.push({ id: row.id, reason: receipt.reason }); continue; }
    await MemoryNote.updateOne({ _id: note._id, status: { $ne: 'forgotten' } },
      { $set: { status: 'forgotten', forgottenAt: now } });
    moved.push({ id: row.id, entryId: receipt.entry.id });
  }
  return { moved, skipped, backup };
}

module.exports = { classify, planMigration, applyMigration, MIGRATION_SOURCE };
