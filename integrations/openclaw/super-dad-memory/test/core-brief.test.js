import test from 'node:test';
import assert from 'node:assert/strict';
import { createCoreBriefClient } from '../core-brief.js';

const reply = (status, body) => ({ ok: status >= 200 && status < 300, status, json: async () => body });
const brief = member => ({ status: 'success', data: { ok: true, authority: 'agentx.core', kind: 'team_brief', member, sections: { mail: { entries: [] } } } });

test('asks Core for one collaborator and returns its checked brief', async () => {
  const seen = [];
  const client = createCoreBriefClient({ baseUrl: 'http://core.invalid', fetchImpl: async (url, init) => { seen.push([String(url), init.method, JSON.parse(init.body)]); return reply(200, brief('secretary')); } });
  const data = await client({ member: ' Secretary ', days: 7, extra: 'ignored' });
  assert.deepEqual(seen, [['http://core.invalid/api/consumers/nestor/v1/team-brief', 'POST', { member: 'secretary', days: 7 }]]);
  assert.equal(data.kind, 'team_brief');
});

test('refuses a brief Core did not sign for that collaborator, and reports refusals', async () => {
  const other = createCoreBriefClient({ baseUrl: 'http://core.invalid', fetchImpl: async () => reply(200, brief('comptable')) });
  await assert.rejects(() => other({ member: 'secretary' }), /receipt is invalid/);
  const refused = createCoreBriefClient({ baseUrl: 'http://core.invalid', fetchImpl: async () => reply(400, { message: 'Choose a collaborator: secretary, comptable' }) });
  await assert.rejects(() => refused({ member: 'nobody' }), /Choose a collaborator/);
  const down = createCoreBriefClient({ baseUrl: 'http://core.invalid', fetchImpl: async () => reply(503, {}) });
  await assert.rejects(() => down({ member: 'secretary' }), /unavailable \(503\)/);
  await assert.rejects(() => down({}), /Name the collaborator/);
  assert.throws(() => createCoreBriefClient({}), /Configure/);
});

test('forwards section and stable record continuation unchanged', async () => {
  const input = { member: 'secretary', section: 'mail', days: 7, limit: 50, offset: 100, asOf: '2026-11-10T00:00:00Z' };
  const client = createCoreBriefClient({ baseUrl: 'http://core.invalid', fetchImpl: async (_url, options) => {
    assert.deepEqual(JSON.parse(options.body), input);
    assert.equal(options.redirect, 'error');
    return reply(200, brief('secretary'));
  } });
  await client(input);
});
