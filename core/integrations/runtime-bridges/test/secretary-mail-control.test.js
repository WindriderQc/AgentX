'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const { SecretaryMailControl } = require('../secretary-mail-control');

const envelope = data => ({ stdout: JSON.stringify({ status: 'success', data }) });
const configured = (sshRunner, extra = {}) => new SecretaryMailControl({ sshTarget: 'operator@host', remoteRoot: '/opt/agentx', sshRunner, ...extra });
const script = '/usr/bin/python3 /opt/agentx/integrations/secretary/secretary_mail_desk.py';

test('threads and handled reach the host with a closed vocabulary only', async () => {
  const commands = [];
  const control = configured(async (target, command) => {
    assert.equal(target, 'operator@host');
    commands.push(command);
    return envelope({ ok: true });
  });
  await control.threads('urgent');
  await control.threads('Needs-Reply');
  await control.handled({ threadId: '1A0A72C7F639BCCF', label: 'urgent' });
  await control.senders();
  assert.deepEqual(commands, [
    `${script} threads --label urgent`,
    `${script} threads --label needs-reply`,
    `${script} handled --label urgent --thread 1a0a72c7f639bccf`,
    `${script} senders`
  ]);
});

test('anything outside the vocabulary is refused before the host is contacted', async () => {
  const control = configured(() => assert.fail('must not contact host'));
  for (const label of ['', 'fyi', 'urgent; reboot', 'urgent --thread x']) {
    await assert.rejects(() => control.threads(label), error => error.statusCode === 400 && error.code === 'SECRETARY_MAIL_BAD_LABEL');
  }
  for (const threadId of ['', '123', '1a0a72c7f639bccf; reboot', '$(reboot)', 'zzzzzzzzzzzzzzzz']) {
    await assert.rejects(() => control.handled({ threadId, label: 'urgent' }), error => error.statusCode === 400 && error.code === 'SECRETARY_MAIL_BAD_THREAD');
  }
  assert.throws(() => new SecretaryMailControl({ remoteRoot: '/srv/../etc' }), error => error.code === 'SECRETARY_MAIL_CONFIGURATION_INVALID');
});

test('a host error envelope keeps its code; transport loss never reflects private stderr', async () => {
  const refused = configured(async () => ({ stdout: JSON.stringify({ status: 'error', code: 'SECRETARY_MAIL_AUTH', statusCode: 503, message: 'Gmail authorization is missing or revoked; the owner must run gog auth add' }) }));
  await assert.rejects(() => refused.threads('urgent'), error => error.code === 'SECRETARY_MAIL_AUTH' && error.statusCode === 503);
  const lost = configured(async () => { throw new Error('secret host output'); });
  await assert.rejects(() => lost.threads('urgent'), error => error.code === 'SECRETARY_MAIL_HOST_UNAVAILABLE' && !error.message.includes('secret'));
  const unconfigured = new SecretaryMailControl({ sshTarget: '', sshRunner: () => assert.fail('must not contact host') });
  assert.equal(unconfigured.available, false);
  await assert.rejects(() => unconfigured.backlog(), error => error.code === 'SECRETARY_MAIL_UNAVAILABLE');
});

test('the unlabelled count is read from Gmail at most once per five minutes', async () => {
  let calls = 0;
  let now = Date.parse('2026-09-20T12:00:00Z');
  const control = configured(async (_target, command) => {
    assert.equal(command, `${script} backlog`);
    calls += 1;
    return envelope({ unlabelled: 60 + calls, capped: false, days: 7 });
  }, { now: () => now });
  assert.equal((await control.backlog()).unlabelled, 61);
  now += 4 * 60 * 1000;
  assert.deepEqual(await control.backlog(), { unlabelled: 61, capped: false, days: 7, checkedAt: '2026-09-20T12:00:00.000Z' });
  now += 2 * 60 * 1000;
  assert.equal((await control.backlog()).unlabelled, 62);
  assert.equal((await control.backlog({ refresh: true })).unlabelled, 63);
  assert.equal(calls, 3);
});

test('concurrent desk loads share one host request, and a failure is not cached', async () => {
  let calls = 0;
  let release;
  const control = configured(() => { calls += 1; return new Promise((resolve) => { release = resolve; }); });
  const first = control.backlog();
  const second = control.backlog();
  release(envelope({ unlabelled: 5, capped: false, days: 7 }));
  assert.equal((await first).unlabelled, 5);
  assert.equal((await second).unlabelled, 5);
  assert.equal(calls, 1);

  let attempts = 0;
  const flaky = configured(async () => { attempts += 1; if (attempts === 1) throw new Error('host down'); return envelope({ unlabelled: 2, capped: false, days: 7 }); });
  await assert.rejects(() => flaky.backlog(), error => error.code === 'SECRETARY_MAIL_HOST_UNAVAILABLE');
  assert.equal((await flaky.backlog()).unlabelled, 2);
});
