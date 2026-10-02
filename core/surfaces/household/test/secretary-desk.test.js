'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const household = require('../briefing');
test("Dad's Desk calls a stopped Gmail triage by its name and counts the mail it left unlabelled", () => {
  const now = new Date('2026-09-19T20:00:00Z');
  const lastRun = Date.parse('2026-09-16T17:07:00Z');
  const jobs = (triage) => ({ data: [
    { id: 'triage', name: 'gmail-oldest-backlog-triage', schedule: { everyMs: 300000 }, ...triage },
    { id: 'watch', name: 'gmail-secretary-health-watchdog', enabled: true, lastRunStatus: 'ok', lastRunAtMs: now.getTime(), schedule: { everyMs: 900000 } }
  ] });
  const desk = (triage, backlog) => household.dadDesk({ data: { alerts: {}, memoryReview: { pending: 0 } } }, [], jobs(triage), now, {}, {}, {}, backlog);

  // The September 2026 outage: enabled, last status ok, silent for three days.
  const silent = desk({ enabled: true, lastRunStatus: 'ok', lastRunAtMs: lastRun }, { unlabelled: 61, capped: false, days: 7, checkedAt: '2026-09-19T19:58:00.000Z' });
  assert.equal(silent.mail.status, 'stopped');
  assert.equal(silent.mail.triage.late, true);
  assert.equal(silent.mail.triage.ageHours, 74.9);
  assert.match(silent.mail.summary, /Dernier tri Gmail : il y a 74\.9 h · attendu toutes les 5 min/);
  assert.deepEqual(silent.mail.backlog, { unlabelled: 61, capped: false, days: 7, checkedAt: '2026-09-19T19:58:00.000Z' });
  const decision = silent.decisions.find((entry) => entry.id === 'mail-triage');
  assert.equal(decision.severity, 'warning');
  assert.match(decision.detail, /61 courriels récents de la boîte de réception sont sans étiquette/);
  assert.equal(silent.status, 'attention');

  const paused = desk({ enabled: false, lastRunStatus: 'error', lastRunAtMs: lastRun }, { error: 'Gmail authorization is missing or revoked; the owner must run gog auth add' });
  assert.equal(paused.mail.status, 'stopped');
  assert.match(paused.mail.summary, /désactivé · dernier passage il y a 74\.9 h/);
  assert.equal(paused.mail.backlog.unlabelled, null);
  assert.match(paused.mail.backlog.error, /gog auth add/);

  // One long catch-up turn is not an outage: nothing is late before thirty minutes.
  const busy = desk({ enabled: true, lastRunStatus: 'ok', lastRunAtMs: now.getTime() - 25 * 60000 }, { unlabelled: 100, capped: true, days: 7 });
  assert.equal(busy.mail.status, 'ready');
  assert.equal(busy.mail.triage.late, false);
  assert.equal(busy.mail.backlog.capped, true);
  assert.equal(busy.decisions.some((entry) => entry.id === 'mail-triage'), false);

  const failing = desk({ enabled: true, lastRunStatus: 'error', lastRunAtMs: now.getTime() - 60000 });
  assert.equal(failing.mail.status, 'attention');
  assert.equal(desk(undefined).mail.status, 'stopped');
});

test('personal tasks say whether they came from chat, email or the desk', () => {
  const origin = (task) => household.publicTask({ pipelineId: '0700', title: 'x', status: 'queued', ...task }).origin;
  assert.equal(origin({ source: 'nestor-secretary' }), 'chat');
  assert.equal(origin({ source: 'nestor-secretary', spec: 'Secretary deep review / action containers-20260916. Demande du 16 septembre.' }), 'email');
  assert.equal(origin({ source: 'household-dad-desk' }), 'manual');
  assert.equal(origin({ source: 'household-secretary' }), 'manual');
  assert.equal(origin({}), 'manual');
  assert.equal(origin({ source: 'household-dad-desk', origin: 'email' }), 'email', 'a stored origin wins over the legacy derivation');
  assert.equal(origin({ source: 'nestor-secretary', origin: 'telepathy' }), 'chat', 'an unknown stored value falls back');
  assert.equal(household.publicTask({ pipelineId: '0700', title: 'x', source: 'idea-drop' }).source, 'idea-drop');
});
