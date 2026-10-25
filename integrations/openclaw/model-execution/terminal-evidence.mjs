import { randomUUID, createHash } from 'node:crypto';
import { mkdir, readFile, writeFile, rename, unlink } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

const PREFIX = 'openclaw-model-terminal:';
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

// An SDK done event can still fail identity, output or usage validation. Keep
// that exact private result before returning the error, without certifying its
// counters, price or success. Each attempted execution has its own receipt.
export function createTerminalEvidenceStore({ directory = join(process.env.OPENCLAW_STATE_DIR || join(homedir(), '.openclaw'),
  'agentx-model-execution', 'terminal-evidence') } = {}) {
  async function record(value) {
    const id = randomUUID(), bytes = Buffer.from(JSON.stringify({ schema: 'agentx.openclaw-terminal-evidence/v1', ...value }));
    if (bytes.length > 8_000_000) throw new Error('OPENCLAW_TERMINAL_EVIDENCE_TOO_LARGE');
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const temp = join(directory, `.${id}.tmp`), file = join(directory, `${id}.json`);
    try {
      await writeFile(temp, bytes, { flag: 'wx', mode: 0o600 });
      await rename(temp, file);
    } catch (error) { await unlink(temp).catch(() => {}); throw error; }
    return { schema: 'agentx.openclaw-terminal-evidence-ref/v1', ref: PREFIX + id, sha256: sha256(bytes),
      requestId: value.requestId, model: value.model, terminalObserved: true, usageValidated: false };
  }
  async function read(ref) {
    const id = typeof ref === 'string' && ref.startsWith(PREFIX) ? ref.slice(PREFIX.length) : '';
    if (!UUID.test(id)) throw Object.assign(new Error('OPENCLAW_TERMINAL_EVIDENCE_REF_INVALID'), { statusCode: 400 });
    const bytes = await readFile(join(directory, `${id}.json`));
    if (bytes.length > 8_000_000) throw new Error('OPENCLAW_TERMINAL_EVIDENCE_TOO_LARGE');
    return { ref, sha256: sha256(bytes), evidence: JSON.parse(bytes) };
  }
  return { record, read };
}
