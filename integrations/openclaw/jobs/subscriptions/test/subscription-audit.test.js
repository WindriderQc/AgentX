'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const audit = require('../subscription-audit.js');

function tempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'subscription-audit-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('fixture run classifies, deduplicates and records resolutions', (t) => {
  const dir = tempDir(t);
  const state = path.join(dir, 'state.json');
  const first = audit.runAudit({ fixture: true, 'report-dir': dir, state });
  assert.equal(first.groups.length, 3);
  const actions = new Set(first.groups.map((group) => group.action));
  assert.ok(actions.has('validate_usage'));
  assert.ok(actions.has('unsubscribe_candidate'));

  const second = audit.runAudit({ fixture: true, 'report-dir': dir, state });
  assert.ok(second.groups.every((group) => group.repeated));
  assert.match(fs.readFileSync(path.join(dir, 'latest.html'), 'utf8'), /No automatic action taken/);

  audit.resolveVendor({ vendor: 'example-audio.invalid', status: 'snoozed', 'snooze-until': '2099-01-01', state });
  const saved = JSON.parse(fs.readFileSync(state, 'utf8'));
  assert.equal(saved.resolutions['example-audio.invalid'].status, 'snoozed');
  const third = audit.runAudit({ fixture: true, 'report-dir': dir, state });
  assert.equal(third.groups.find((group) => group.key === 'example-audio.invalid').action, 'manual_review');
});

test('input rows from the Gmail wrapper are grouped by sender domain', (t) => {
  const dir = tempDir(t);
  const input = path.join(dir, 'input.json');
  fs.writeFileSync(input, JSON.stringify([
    { from: 'Example Stream <billing@example-stream.invalid>', subject: 'Subscription cancelled', date: '2026-05-01', labels: [] },
    { from: 'Example Stream <billing@example-stream.invalid>', subject: 'Receipt', date: '2026-04-01', labels: [] }
  ]));
  const result = audit.runAudit({ input, 'report-dir': dir, state: path.join(dir, 'state.json'), source: 'synthetic' });
  assert.equal(result.groups.length, 1);
  assert.equal(result.groups[0].action, 'cancelled_or_done');
  assert.equal(result.groups[0].count, 2);
  assert.equal(result.run.dryRun, false);
});

test('resolve rejects unknown statuses', () => {
  assert.throws(() => audit.resolveVendor({ vendor: 'example.invalid', status: 'deleted' }), /--status must be one of/);
});
