import { createHash } from 'node:crypto';
import { readFile, readdir, unlink } from 'node:fs/promises';
import path from 'node:path';
import { privateDirectory, privateJson } from './private-state.js';
import { journalTriage } from './triage-journal.js';
import { buildReadCommand, runGog, unwrapExternalText } from './gmail.js';

const directory = config => path.join(config.evidenceRoot || path.dirname(config.triageStateFile), 'transport-state', 'gmail-journal-outbox');
const terminal = value => value.recorded === true || ['already journaled', 'older than the journal retention'].includes(value.reason);

export async function stageJournal(config, params) {
  const entry = Object.fromEntries(['threadId', 'messageId', 'category', 'occurredAt', 'summary', 'subject', 'counterpart']
    .filter(key => params[key] !== undefined).map(key => [key, params[key]]));
  const id = createHash('sha256').update(JSON.stringify([config.account, config.coreUrl, entry])).digest('hex');
  const root = directory(config), file = path.join(root, `${id}.json`);
  await privateDirectory(root);
  const receipt = { schema: 'secretary.journal-delivery/v1', id, phase: 'prepared', at: new Date().toISOString(), entry };
  try { await privateJson(file, receipt, { exclusive: true }); }
  catch (error) {
    if (error.code !== 'EEXIST') throw error;
    const prior = JSON.parse(await readFile(file, 'utf8'));
    if (prior.id !== id || JSON.stringify(prior.entry) !== JSON.stringify(entry)) throw new Error('The original journal delivery requires reconciliation');
    return { file, receipt: prior };
  }
  return { file, receipt };
}

async function deliver(config, staged, fetchImpl) {
  const value = await journalTriage(config, staged.receipt.entry, fetchImpl);
  if (terminal(value)) { await unlink(staged.file).catch(error => { if (error.code !== 'ENOENT') throw error; }); return value; }
  return { ...value, queued: true };
}

export async function commitJournal(config, staged, fetchImpl = globalThis.fetch) {
  const receipt = { ...staged.receipt, phase: 'ready' };
  try { await privateJson(staged.file, receipt); }
  catch { return { recorded: false, queued: true, reason: 'The classification is confirmed; its retained delivery needs reconciliation' }; }
  return deliver(config, { ...staged, receipt }, fetchImpl);
}

async function classificationApplied(config, entry, run) {
  const labels = await run(buildReadCommand({ kind: 'labels' }, config), config);
  const rows = Array.isArray(labels) ? labels : labels.labels || [];
  const wanted = ['Secretary/Processed', `Secretary/${entry.category}`].map(name => rows.find(row => unwrapExternalText(row.name) === name)?.id);
  if (wanted.some(id => !id)) return false;
  const result = await run(buildReadCommand({ kind: 'message', id: entry.messageId, format: 'metadata' }, config), config);
  const message = result.message || result;
  return message.id === entry.messageId && message.threadId === entry.threadId && wanted.every(id => message.labelIds?.includes(id));
}

// A bounded retry runs even when no mail remains unclassified. Prepared entries
// are delivered only after native labels confirm the exact message's effect.
export async function flushJournal(config, { fetchImpl = globalThis.fetch, run = runGog, applied = classificationApplied, limit = 3 } = {}) {
  let names;
  try { names = (await readdir(directory(config))).filter(name => /^[a-f0-9]{64}\.json$/.test(name)).sort(); }
  catch (error) { if (error.code === 'ENOENT') return { pending: 0, delivered: 0 }; throw error; }
  let delivered = 0;
  let cursor = '';
  try { cursor = JSON.parse(await readFile(path.join(directory(config), 'cursor.json'), 'utf8')).after || ''; } catch {}
  const next = names.findIndex(name => name > cursor);
  const ordered = next < 0 ? names : [...names.slice(next), ...names.slice(0, next)];
  const selected = ordered.slice(0, limit);
  if (selected.length) await privateJson(path.join(directory(config), 'cursor.json'), { after: selected.at(-1) });
  for (const name of selected) {
    const file = path.join(directory(config), name);
    let receipt;
    try {
      receipt = JSON.parse(await readFile(file, 'utf8'));
      if (receipt.schema !== 'secretary.journal-delivery/v1' || receipt.id !== name.slice(0, -5)) break;
      if (receipt.phase !== 'ready' && !await applied(config, receipt.entry, run)) continue;
      const value = await commitJournal(config, { file, receipt }, fetchImpl);
      if (terminal(value)) delivered++;
      else break; // One unreachable Core does not cause three identical waits.
    } catch { break; } // Preserve the original intent; the next native turn can retry.
  }
  return { pending: Math.max(0, names.length - delivered), delivered };
}
