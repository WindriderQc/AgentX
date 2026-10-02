#!/usr/bin/env node
/**
 * Move mail digests saved as personal notes into the mail journal.
 *
 *   node scripts/migrate-mail-digests.js --report <file.json>
 *       Dry run: writes the classification (id, kind, first words) to <file>.
 *   node scripts/migrate-mail-digests.js --apply --backup <file.json> [--ids <file.json>]
 *       Writes the full notes to <backup> first, then journals each digest and
 *       forgets its note. --ids limits the run to note ids listed in a JSON array.
 *
 * Report and backup hold private text: write them outside Git.
 */
require('dotenv').config();
const fs = require('node:fs');
const mongoose = require('mongoose');
const { planMigration, digestNotes, applyMigration } = require('../src/services/mailDigestMigration');

function option(name) {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
}

async function main() {
  const apply = process.argv.includes('--apply');
  const target = apply ? option('--backup') : option('--report');
  if (!target) throw new Error(apply ? '--apply needs --backup <file>' : 'pass --report <file> (dry run) or --apply --backup <file>');
  if (fs.existsSync(target)) throw new Error(`${target} already exists; choose a new file`);
  await mongoose.connect(process.env.MONGODB_URI || 'mongodb://localhost:27017/agentx');
  try {
    if (!apply) {
      const plan = await planMigration();
      fs.writeFileSync(target, JSON.stringify(plan, null, 2), { mode: 0o600 });
      console.log(`dry run: ${plan.total} notes, ${plan.digests} digests, ${plan.review} to review, ${plan.facts} facts -> ${target}`);
      return;
    }
    const idsFile = option('--ids');
    const ids = idsFile ? JSON.parse(fs.readFileSync(idsFile, 'utf8')) : undefined;
    fs.writeFileSync(target, JSON.stringify(await digestNotes(ids), null, 2), { mode: 0o600 });
    const result = await applyMigration({ ids });
    console.log(`moved ${result.moved.length} digests to the mail journal, skipped ${result.skipped.length}; backup ${target}`);
    result.skipped.forEach(row => console.log(`  skipped ${row.id}: ${row.reason}`));
  } finally {
    await mongoose.disconnect();
  }
}

main().catch(err => { console.error(err.message); process.exitCode = 1; });
