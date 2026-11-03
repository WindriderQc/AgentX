import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename, unlink } from 'node:fs/promises';
import path from 'node:path';

const digest = value => createHash('sha256').update(value).digest('hex');
const canonical = value => value && typeof value === 'object'
  ? Array.isArray(value) ? value.map(canonical)
    : Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
const pending = id => Object.assign(new Error(`Gmail send result is uncertain (receipt ${id}). Reconcile this original call in Sent before any new delivery; do not retry with a new identity.`),
  { code: 'GMAIL_SEND_RECONCILIATION_REQUIRED', receiptId: id });

async function durable(file, value, { exclusive = false } = {}) {
  const target = exclusive ? file : `${file}.${randomUUID()}.tmp`;
  const handle = await open(target, 'wx', 0o600);
  try { await handle.writeFile(JSON.stringify(value)); await handle.sync(); }
  finally { await handle.close(); }
  if (!exclusive) {
    try { await rename(target, file); }
    catch (error) { await unlink(target).catch(() => {}); throw error; }
  }
}

// Transport receipts remain private beside the native triage state. This is
// not a second mailbox/task store. An uncertain delivery has no timed takeover.
export async function sendOnce({ callId, context, params, config, dispatch }) {
  if (!callId || !context?.agentId || !context?.sessionKey) throw new Error('A native session and tool call identity are required for Gmail send');
  const id = digest(JSON.stringify([config.account, context.agentId, context.sessionKey, callId]));
  const requestHash = digest(JSON.stringify(canonical(params)));
  const root = path.join(path.dirname(config.triageStateFile), 'gmail-send-receipts');
  const file = path.join(root, `${id}.json`);
  await mkdir(root, { recursive: true, mode: 0o700 });
  const intent = { schema: 'secretary.gmail-send/v1', id, requestHash, phase: 'dispatching', at: new Date().toISOString() };
  try { await durable(file, intent, { exclusive: true }); }
  catch (error) {
    if (error.code !== 'EEXIST') throw error; // no dispatch when the intent cannot be retained
    let receipt;
    try { receipt = JSON.parse(await readFile(file, 'utf8')); }
    catch { throw pending(id); }
    if (receipt.schema !== intent.schema || receipt.id !== id || receipt.requestHash !== requestHash) {
      throw Object.assign(new Error('The original Gmail send identity has different arguments or an invalid receipt.'), { code: 'GMAIL_SEND_IDENTITY_CONFLICT' });
    }
    if (receipt.phase !== 'sent' || !receipt.result) throw pending(id);
    return { ...receipt.result, sendReceipt: { id, phase: 'sent', replayed: true } };
  }
  let value;
  try { value = await dispatch(); }
  catch { throw pending(id); }
  if (!String(value?.messageId || value?.id || value?.message?.id || '').trim()) throw pending(id);
  try { await durable(file, { ...intent, phase: 'sent', completedAt: new Date().toISOString(), result: value }); }
  catch {
    // The provider response is certain even if its durable result could not be
    // saved. Keep the initial fence and tell the caller exactly what succeeded.
    return { ...value, sendReceipt: { id, phase: 'sent', durable: false, reconciliationRequired: true } };
  }
  return { ...value, sendReceipt: { id, phase: 'sent', durable: true } };
}
