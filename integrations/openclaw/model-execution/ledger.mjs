import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

const SCHEMA = 'agentx.openclaw-paid-spend/v1';
const count = value => Number.isSafeInteger(value) && value >= 0;

// Running total of dispatched paid model-mode calls. Amounts are runtime
// estimates from native catalogue rates, not invoices; a call whose cost was
// not observed is counted, never priced.
export function createSpendLedger({ file = join(process.env.OPENCLAW_STATE_DIR || join(homedir(), '.openclaw'), 'agentx-model-execution', 'paid-spend.json'),
  now = () => Date.now() } = {}) {
  let state = null, queue = Promise.resolve();
  async function load() {
    if (state) return state;
    try {
      const stored = JSON.parse(await readFile(file, 'utf8'));
      if (stored.schema !== SCHEMA || ![stored.paidCalls, stored.nanodollars, stored.unknownCostCalls].every(count)) throw new Error('invalid paid spend ledger');
      state = { ...stored, saved: true };
    } catch (error) {
      if (error.code !== 'ENOENT') throw Object.assign(new Error('OPENCLAW_SPEND_LEDGER_UNAVAILABLE'), { code: 'OPENCLAW_SPEND_LEDGER_UNAVAILABLE', statusCode: 503 });
      state = { schema: SCHEMA, currency: 'USD', costSource: 'runtime-estimate', since: new Date(now()).toISOString(),
        updatedAt: null, paidCalls: 0, nanodollars: 0, unknownCostCalls: 0, saved: true };
    }
    return state;
  }
  async function save() {
    const { saved, ...stored } = state;
    const temp = `${file}.${randomUUID()}.tmp`;
    try {
      await mkdir(dirname(file), { recursive: true, mode: 0o700 });
      await writeFile(temp, JSON.stringify(stored), { encoding: 'utf8', flag: 'wx', mode: 0o600 });
      await rename(temp, file);
      state.saved = true;
    } catch {
      // The provider call already happened: keep the total in memory and say it is not on disk.
      state.saved = false;
      await unlink(temp).catch(() => {});
    }
  }
  const read = async () => ({ ...await load() });
  const record = nanodollars => (queue = queue.then(async () => {
    await load();
    state.paidCalls += 1;
    if (count(nanodollars)) state.nanodollars += nanodollars; else state.unknownCostCalls += 1;
    state.updatedAt = new Date(now()).toISOString();
    await save();
  }));
  return { read, record };
}
