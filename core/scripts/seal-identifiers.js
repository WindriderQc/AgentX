#!/usr/bin/env node
/**
 * Move sensitive identifiers already stored in memory notes and mail journal
 * entries into the encrypted identifier vault (needs IDENTIFIER_VAULT_KEY).
 *
 *   node scripts/seal-identifiers.js              Dry run: counts by kind, no values.
 *   node scripts/seal-identifiers.js --apply --backup <file.json>
 *       Writes the original texts that will change to <backup>, then seals them.
 *
 * The backup holds the identifiers in clear text: write it outside Git and
 * delete it once the result is checked.
 */
require('dotenv').config();
const fs = require('node:fs');
const mongoose = require('mongoose');
const { vaultKey, findIdentifiers, sealText } = require('../src/services/identifierVault');

const SOURCES = [
  { collection: 'household_voice_memories', fields: ['text'], seenIn: 'memory-note' },
  { collection: 'mail_journal_entries', fields: ['summary', 'subject'], seenIn: 'mail-journal' },
];

function option(name) {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
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
    const changes = [];
    const kinds = {};
    for (const source of SOURCES) {
      for (const row of await db.collection(source.collection).find({}).toArray()) {
        for (const field of source.fields) {
          const found = findIdentifiers(row[field] || '');
          if (!found.length) continue;
          found.forEach(item => { kinds[item.kind] = (kinds[item.kind] || 0) + 1; });
          changes.push({ collection: source.collection, _id: row._id, field, original: row[field], seenIn: source.seenIn });
        }
      }
    }
    console.log(`${changes.length} texts hold identifiers: ${JSON.stringify(kinds)}`);
    if (!apply) return;
    fs.writeFileSync(backupFile, JSON.stringify(changes, null, 2), { mode: 0o600 });
    for (const change of changes) {
      const { text } = await sealText(change.original, { seenIn: change.seenIn });
      await db.collection(change.collection).updateOne({ _id: change._id, [change.field]: change.original },
        { $set: { [change.field]: text } });
    }
    console.log(`sealed ${changes.length} texts; backup ${backupFile}`);
  } finally {
    await mongoose.disconnect();
  }
}

main().catch(err => { console.error(err.message); process.exitCode = 1; });
