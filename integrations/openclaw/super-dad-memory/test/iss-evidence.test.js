import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { recordTool } from '../harness.js';
import { readState } from '../store.js';

const data = { status: 'ok', computedAt: '2026-01-01T00:00:00Z',
  window: { start: '2026-01-01T00:00:00Z', end: '2026-01-02T00:00:00Z' },
  observer: { label: 'Synthetic location' }, tle: { epoch: '2026-01-01T00:00:00Z', stale: false },
  counts: { geometric: 0, observable: 0 }, passes: [] };

test('Core ISS reads verify execution while delivery and missing result references stay unknown', async t => {
  const workspace = await mkdtemp(path.join(tmpdir(), 'iss-evidence-'));
  t.after(() => rm(workspace, { recursive: true }));
  const context = { sessionKey: 'synthetic-session', runId: 'synthetic-run' };
  for (const [i, result] of [{ details: data }, { structuredContent: data },
    { content: [{ type: 'text', text: JSON.stringify(data) }] }, { details: { status: 'ok' } },
    { isError: true, details: data }, { details: { ...data, counts: { geometric: 0, observable: 1 } } }].entries()) {
    await recordTool(workspace, { toolName: 'nestor_iss', toolCallId: `call-${i}`, result }, context);
  }
  const { receipts } = await readState(workspace);
  assert.deepEqual(receipts.map(r => r.status), ['verified', 'verified', 'verified', 'unknown', 'failed', 'unknown']);
  assert.ok(receipts.every(r => r.deliveryState === 'unknown' && r.resultRef === null));
  assert.doesNotMatch(JSON.stringify(receipts), /Synthetic location|geometric|passes/);
});
