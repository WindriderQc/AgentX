import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { contextFor } from '../harness.js';
import { updateState, readState } from '../store.js';

test('requested context is bounded, preserves task date flags and excludes other chats without erasing receipts', async t => {
  const workspace = await mkdtemp(path.join(tmpdir(), 'agentx-context-'));
  t.after(() => rm(workspace, { recursive: true }));
  const receipts = Array.from({ length: 8 }, (_, i) => ({ id: String(i), sessionKey: 'current',
    tool: 'synthetic', status: 'verified', resultRef: 'personal-task:0001', observed: true,
    provenance: { largeMetadata: 'x'.repeat(5000) } }));
  receipts.push({ id: 'unrelated', sessionKey: 'other', status: 'failed' });
  await updateState(workspace, state => ({ ...state, receipts }));
  const tasks = Array.from({ length: 25 }, (_, i) => ({ id: String(i), title: 'Synthetic task',
    note: 'x'.repeat(2000), dueLocal: '2030-01-02', lane: 'today', dueToday: true,
    overdue: false, recheck: false, expired: false, status: 'queued', priority: 3 }));
  const context = await contextFor(workspace, 'synthetic', { sessionKey: 'current',
    includeMemory: true, includeTasks: true,
    readNotes: async () => ({ notes: [{ id: 'a'.repeat(24), text: 'x'.repeat(2000),
      kind: 'fact', hugeMetadata: 'x'.repeat(10000) }] }),
    readTasks: async () => ({ tasks, totalCount: 50, hasMore: true, dueTodayCount: 25,
      overdueCount: 2, todayLocal: '2030-01-02' }) });
  assert.deepEqual(context.receipts.map(r => r.id), ['4', '5', '6', '7']);
  assert.equal(context.tasks.length, 12);
  assert.deepEqual(context.tasks[0], { id: '0', title: 'Synthetic task', status: 'queued',
    dueAt: undefined, dueLocal: '2030-01-02', relevantUntilLocal: undefined, priority: 3,
    lane: 'today', dueToday: true, overdue: false, recheck: false, expired: false });
  assert.deepEqual(context.taskCoverage, { returned: 12, total: 50, hasMore: true,
    dueTodayCount: 25, overdueCount: 2, todayLocal: '2030-01-02', fullReadTool: 'list_personal_tasks' });
  assert.equal(context.notes[0].textTruncated, true);
  assert.equal(context.notes[0].text.length, 800);
  assert.ok(JSON.stringify(context).length < 6000);
  assert.equal((await readState(workspace)).receipts.length, 9);
});

test('context does not consult unrequested sources or include unscoped receipts', async t => {
  const workspace = await mkdtemp(path.join(tmpdir(), 'agentx-context-'));
  t.after(() => rm(workspace, { recursive: true }));
  const unexpected = () => { throw new Error('Unexpected source read'); };
  const result = await contextFor(workspace, 'synthetic', { readTasks: unexpected, readNotes: unexpected });
  assert.deepEqual(result.receipts, []);
  assert.deepEqual(result.notes, []);
  assert.equal(result.sources.personal_memory, 'not_consulted');
  assert.equal(result.tasks, undefined);
});
