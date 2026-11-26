import assert from 'node:assert/strict';
import test from 'node:test';
import { briefingFromCore, readMorningBriefing } from '../harness.js';
import readModel from '../../../../core/src/services/heavyWorkQueueReadModel.js';

const now = Date.parse('2030-01-02T12:00:00Z');
const time = minutes => new Date(now + minutes * 60000).toISOString();
const slot = (id, start, end, autoStart) => ({
  id, kind: 'profiler', state: 'reserved', executor: { hostId: 'example' },
  reservation: { start: time(start), end: time(end), autoStart },
});
const rows = [
  slot('manual', -5, 10, false), slot('automatic', 10, 20, true), slot('expired', -20, -10, true),
];
function queue(jobs) {
  return { authority: 'core.heavy-work-queue', summary: readModel.summarize(jobs, { now }),
    jobs: jobs.slice(0, 1).map(job => readModel.project(job, { now })), offset: 0, limit: 1 };
}
const personal = { text: 'Urgence\nDécision\nRappel\nPréparation\nSuivi\nAutre tâche',
  sourceCoverage: { tasks: 'read' } };

test('the verbatim morning text includes global counts and independent slots despite a one-row page', () => {
  const receipt = queue(rows);
  const result = briefingFromCore(personal, receipt);
  assert.equal(result.lines?.at(-1), 'Travaux lourds — 1 en file automatique, 2 en attente d’action. Réservations 3 (à venir 1, ouvertes 1, expirées 1).');
  assert.deepEqual(result.lines.slice(0, 5), personal.text.split('\n').slice(0, 5));
  assert.equal(result.text, result.lines.join('\n'));
  assert.deepEqual(result.workQueueSummary, receipt.summary);
  assert.equal(result.deliveryState, 'not_requested');
});

test('empty, invalid and unavailable queues stay distinguishable from an unrequested section', () => {
  const empty = briefingFromCore(personal, queue([]));
  assert.match(empty.text, /0 en file automatique, 0 en attente d’action\. Réservations 0/);
  const invalid = slot('invalid', 10, -5, true);
  assert.match(briefingFromCore(personal, queue([invalid])).text, /à vérifier 1/);
  for (const receipt of [null, { counts: { requested: 1 } }, { ...queue([]), summary: { counts: {} } }]) {
    const unavailable = briefingFromCore(personal, receipt);
    assert.equal(unavailable.lines.at(-1), 'Travaux lourds — file de Core indisponible.');
    assert.equal(unavailable.workQueueSummary, null);
  }
  assert.equal(briefingFromCore(personal).text, personal.text);
});

test('an opted-in morning brief reads the list once and keeps pending outcome notifications separate', async () => {
  const calls = [];
  const fetchFixture = async (url, options) => {
    const body = options.body ? JSON.parse(options.body) : {};
    calls.push([url.pathname, body.action ?? body.params?.name ?? body.operation]);
    if (url.pathname === '/mcp') return Response.json({ result: { structuredContent: personal } });
    if (body.action === 'list') {
      assert.deepEqual(body, { action: 'list', limit: 1 });
      return Response.json({ status: 'success', data: queue(rows) });
    }
    if (body.action === 'notifications') return Response.json({ status: 'success', data: { notifications: [] } });
    return Response.json({ status: 'success', data: { authority: 'agentx.core', pending: 0 } });
  };
  for (const options of [{}, { includeWorkQueue: true }]) {
    calls.length = 0;
    const result = await readMorningBriefing('http://core.invalid', options, fetchFixture);
    const reads = [['/mcp', 'personal_briefing']];
    if (options.includeWorkQueue) reads.push(['/api/consumers/nestor/v1/work-queue', 'list']);
    assert.deepEqual(calls, [...reads, ['/api/consumers/nestor/v1/work-queue', 'notifications'],
      ['/api/finance/brief', undefined], ['/api/consumers/nestor/v1/memory/history', 'status']]);
    assert.equal(result.text.includes('Réservations 3'), options.includeWorkQueue === true);
    assert.deepEqual(result.workQueue, { notifications: [] });
    assert.equal(result.deliveryState, 'not_requested');
  }
});
