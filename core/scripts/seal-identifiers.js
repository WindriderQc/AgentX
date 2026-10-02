#!/usr/bin/env node
/**
 * Move sensitive identifiers already stored in owner memory notes and mail
 * journal entries into the encrypted identifier vault (needs IDENTIFIER_VAULT_KEY).
 *
 *   node scripts/seal-identifiers.js              Dry run: counts by kind, no values.
 *   node scripts/seal-identifiers.js --apply --backup <file.json>
 *       Writes the original rows that will change to <backup>, then seals them.
 *
 * A sealed note also gets a new content hash and, when its id was derived from
 * its text, a new id: neither may keep a fingerprint of the clear value.
 * The backup holds the identifiers in clear text: write it outside Git and
 * delete it once the result is checked.
 */
require('dotenv').config();
const fs = require('node:fs');
const { createHash } = require('node:crypto');
const mongoose = require('mongoose');
const { vaultKey, findIdentifiers, sealText } = require('../src/services/identifierVault');

const sha256 = value => createHash('sha256').update(value).digest('hex');
// Same identity as memoryNoteService.remember().
const noteIdOf = (row, text) => sha256([row.scopeId, row.packId, text].join('\n')).slice(0, 24);

function option(name) {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
}

async function sealNote(db, row) {
  const notes = db.collection('household_voice_memories');
  const { text } = await sealText(row.text, { seenIn: 'memory-note' });
  const values = { text, contentHash: sha256(text.toLowerCase()) };
  if (String(row._id) !== noteIdOf(row, row.text)) {
    return (await notes.updateOne({ _id: row._id, text: row.text }, { $set: values })).matchedCount;
  }
  const _id = new mongoose.Types.ObjectId(noteIdOf(row, text));
  try {
    await notes.insertOne({ ...row, ...values, _id });
  } catch (failure) {
    // The same sealed note already exists: keep it and drop this copy.
    if (failure.code !== 11000) throw failure;
  }
  return (await notes.deleteOne({ _id: row._id, text: row.text })).deletedCount;
}

async function main() {
  if (!vaultKey()) throw new Error('IDENTIFIER_VAULT_KEY is not set');
  const apply = process.argv.includes('--apply');
  const backupFile = option('--backup');
  if (apply && !backupFile) throw new Error('--apply needs --backup <file>');
  if (backupFile && fs.existsSync(backupFile)) throw new Error(`${backupFile} already exists; choose a new file`);
  await mongoose.connect(process.env.MONGODB_URI || 'mongodb://localhost:27017/agentx');
  try {
    const db = mongoose.connection.db;
    const kinds = {};
    const count = text => findIdentifiers(text || '').forEach(item => { kinds[item.kind] = (kinds[item.kind] || 0) + 1; });
    // Family notes are never sealed: a family space cannot reveal a value.
    const notes = (await db.collection('household_voice_memories').find({ scope: { $ne: 'household' } }).toArray())
      .filter(row => findIdentifiers(row.text || '').length);
    const entries = (await db.collection('mail_journal_entries').find({}).toArray())
      .filter(row => findIdentifiers(row.summary || '').length || findIdentifiers(row.subject || '').length);
    notes.forEach(row => count(row.text));
    entries.forEach(row => { count(row.summary); count(row.subject); });
    console.log(`${notes.length} notes and ${entries.length} journal entries hold identifiers: ${JSON.stringify(kinds)}`);
    if (!apply) return;
    fs.writeFileSync(backupFile, JSON.stringify({ notes, entries }, null, 2), { mode: 0o600 });
    let changed = 0;
    for (const row of notes) changed += await sealNote(db, row);
    for (const row of entries) {
      const summary = (await sealText(row.summary || '', { seenIn: 'mail-journal' })).text;
      const subject = (await sealText(row.subject || '', { seenIn: 'mail-journal' })).text;
      changed += (await db.collection('mail_journal_entries').updateOne(
        { _id: row._id, summary: row.summary }, { $set: { summary, subject } })).matchedCount;
    }
    console.log(`sealed ${changed} of ${notes.length + entries.length} rows; backup ${backupFile}`);
  } finally {
    await mongoose.disconnect();
  }
}

if (require.main === module) main().catch(err => { console.error(err.message); process.exitCode = 1; });

module.exports = { sealNote, noteIdOf };
