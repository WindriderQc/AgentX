'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  formatMessage,
  formatResolution,
  inQuietHours,
  parseArgs,
  readToken,
  run,
  selectDue,
  validateConfig,
} = require('../alert-telegram-relay');

const TOKEN = '123456789:AAFakeTokenForTestsOnly_abcdefghij';
const NOW = Date.parse('2026-09-27T20:00:00Z');

function alert(overrides = {}) {
  return {
    _id: 'a1',
    ruleId: 'pin-vram-spill',
    ruleName: 'Pinned model not in VRAM',
    severity: 'critical',
    status: 'active',
    title: 'Pinned model off GPU — http://192.168.2.99:11434',
    message: 'pin_partial_spill for qllama/bge-m3:f16. Check the GPU driver.',
    channels: ['local_log', 'telegram'],
    delivery: { telegram: { sent: false, error: 'External notification delivery is not embedded in Agent X.' } },
    createdAt: '2026-09-27T19:50:00Z',
    lastNotifiedAt: '2026-09-27T19:50:00Z',
    occurrenceCount: 3,
    notificationCount: 1,
    ...overrides,
  };
}

const CONFIG = validateConfig({
  chatId: '-1003733742621',
  topicId: '700',
  tokenFile: '/secrets/openclaw.json',
  tokenPointer: '/openclaw/channels/telegram/botToken',
  maxPerRun: 5,
});

function memoryState(initial = { relayed: {} }) {
  const box = { state: JSON.parse(JSON.stringify(initial)), writes: 0 };
  return {
    box,
    readState: () => JSON.parse(JSON.stringify(box.state)),
    writeState: (_file, state) => { box.state = JSON.parse(JSON.stringify(state)); box.writes += 1; },
  };
}

function fakeFetch(routes) {
  const calls = [];
  const impl = async (url, init = {}) => {
    const body = init.body ? JSON.parse(init.body) : null;
    calls.push({ url, method: init.method, body });
    const route = routes.find(([pattern]) => pattern.test(url));
    const [, status, payload] = route || [null, 404, { ok: false }];
    return { ok: status < 400, status, json: async () => (typeof payload === 'function' ? payload(body) : payload) };
  };
  impl.calls = calls;
  return impl;
}

test('selects only active, undelivered, recent alerts that ask for Telegram', () => {
  const alerts = [
    alert({ _id: 'due' }),
    alert({ _id: 'local-only', channels: ['local_log'] }),
    alert({ _id: 'already-sent', delivery: { telegram: { sent: true } } }),
    alert({ _id: 'resolved', status: 'resolved' }),
    alert({ _id: 'acknowledged', status: 'acknowledged' }),
    alert({ _id: 'stale', lastNotifiedAt: '2026-09-25T19:00:00Z' }),
    alert({ _id: 'never-attempted', delivery: {} }),
  ];
  assert.deepEqual(selectDue(alerts, { now: NOW }).map((a) => a._id), ['due', 'never-attempted']);
  assert.equal(selectDue([alert(), alert(), alert()], { now: NOW, maxPerRun: 2 }).length, 2);
});

test('formats a compact French message with severity, reminder and link', () => {
  const text = formatMessage(alert({ notificationCount: 2 }), { alertsUrl: 'https://agentx.example/alerts' });
  assert.equal(text.split('\n')[0], '🔴 CRITIQUE · rappel · Pinned model off GPU — http://192.168.2.99:11434');
  assert.match(text, /pin_partial_spill for qllama\/bge-m3:f16/);
  assert.match(text, /Règle pin-vram-spill · 3 occurrences · depuis 2026-09-27 19:50 UTC/);
  assert.match(text, /https:\/\/agentx\.example\/alerts$/);
  assert.ok(formatMessage(alert({ message: 'x'.repeat(5000) })).length <= 3500);
});

test('reads the token from a JSON pointer or a raw file and rejects junk', () => {
  const json = JSON.stringify({ openclaw: { channels: { telegram: { botToken: TOKEN } } } });
  assert.equal(readToken('f', '/openclaw/channels/telegram/botToken', () => json), TOKEN);
  assert.equal(readToken('f', null, () => `${TOKEN}\n`), TOKEN);
  assert.throws(() => readToken('f', '/missing', () => json), /missing or malformed/);
});

test('validates the config', () => {
  assert.throws(() => validateConfig({ chatId: 'ops', tokenFile: 'f' }), /chatId/);
  assert.throws(() => validateConfig({ chatId: '-1', topicId: 'x', tokenFile: 'f' }), /topicId/);
  assert.throws(() => validateConfig({ chatId: '-1' }), /tokenFile/);
  assert.equal(validateConfig({ chatId: '-1', tokenFile: 'f' }).maxPerRun, 5);
});

test('preview reads Core but never calls Telegram or writes delivery', async () => {
  const fetch = fakeFetch([[/\/api\/alerts\?status=active/, 200, { data: { alerts: [alert()] } }]]);
  const summary = await run(parseArgs([]), { fetch, config: CONFIG, now: () => NOW, ...memoryState() });
  assert.equal(summary.mode, 'preview');
  assert.equal(summary.due, 1);
  assert.match(summary.items[0].preview, /CRITIQUE/);
  assert.equal(fetch.calls.length, 1);
});

test('send posts to the topic and records delivery in Core', async () => {
  const fetch = fakeFetch([
    [/\/api\/alerts\?status=active/, 200, { data: { alerts: [alert()] } }],
    [/api\.telegram\.org\/bot.+\/sendMessage/, 200, { ok: true, result: { message_id: 1 } }],
    [/\/api\/alerts\/a1\/delivery-status/, 200, { status: 'success' }],
  ]);
  const summary = await run(parseArgs(['--send']), { fetch, config: CONFIG, token: TOKEN, now: () => NOW, ...memoryState() });
  assert.equal(summary.sent, 1);
  const send = fetch.calls.find((c) => /sendMessage/.test(c.url));
  assert.equal(send.body.chat_id, '-1003733742621');
  assert.equal(send.body.message_thread_id, 700);
  const record = fetch.calls.find((c) => /delivery-status/.test(c.url));
  assert.deepEqual({ channel: record.body.channel, status: record.body.status }, { channel: 'telegram', status: 'sent' });
});

test('a Telegram failure is recorded without leaking the token', async () => {
  const fetch = fakeFetch([
    [/\/api\/alerts\?status=active/, 200, { data: { alerts: [alert()] } }],
    [/api\.telegram\.org/, 400, { ok: false, description: `Bad Request: message thread not found (${TOKEN})` }],
    [/delivery-status/, 200, { status: 'success' }],
  ]);
  const summary = await run(parseArgs(['--send']), { fetch, config: CONFIG, token: TOKEN, now: () => NOW, ...memoryState() });
  assert.equal(summary.failed, 1);
  const record = fetch.calls.find((c) => /delivery-status/.test(c.url));
  assert.equal(record.body.status, 'failed');
  assert.match(record.body.error, /message thread not found/);
  assert.ok(!JSON.stringify(summary).includes(TOKEN));
  assert.ok(!record.body.error.includes(TOKEN));
});

const QUIET = validateConfig({
  chatId: '-1', tokenFile: 'f',
  quietHours: { start: '23:59', end: '07:00', timeZone: 'America/Toronto' },
}).quietHours;

test('quiet hours wrap midnight in the owner time zone', () => {
  // 2026-09-28 is EDT (UTC-4).
  assert.equal(inQuietHours(Date.parse('2026-09-28T03:58:00Z'), QUIET), false); // 23:58 EDT
  assert.equal(inQuietHours(Date.parse('2026-09-28T03:59:00Z'), QUIET), true);  // 23:59 EDT, start
  assert.equal(inQuietHours(Date.parse('2026-09-28T04:00:00Z'), QUIET), true);  // 00:00 EDT
  assert.equal(inQuietHours(Date.parse('2026-09-28T10:59:00Z'), QUIET), true);  // 06:59 EDT
  assert.equal(inQuietHours(Date.parse('2026-09-28T11:00:00Z'), QUIET), false); // 07:00 EDT
  assert.equal(inQuietHours(Date.parse('2026-09-28T16:00:00Z'), QUIET), false); // noon
  assert.equal(inQuietHours(Date.parse('2026-09-28T16:00:00Z'), null), false);
  assert.throws(() => validateConfig({ chatId: '-1', tokenFile: 'f', quietHours: { start: '25:00', end: '07:00' } }), /HH:MM/);
});

test('inside quiet hours only critical alerts are due', () => {
  const night = Date.parse('2026-09-28T06:00:00Z'); // 02:00 EDT
  const alerts = [
    alert({ _id: 'crit', lastNotifiedAt: '2026-09-28T05:50:00Z' }),
    alert({ _id: 'err', severity: 'error', lastNotifiedAt: '2026-09-28T05:50:00Z' }),
  ];
  assert.deepEqual(selectDue(alerts, { now: night, quietHours: QUIET }).map((a) => a._id), ['crit']);
  assert.deepEqual(selectDue(alerts, { now: night }).map((a) => a._id), ['crit', 'err']);
});

test('formats a resolution notice with how and how long', () => {
  const text = formatResolution(alert({
    status: 'resolved',
    resolution: { resolvedAt: '2026-09-27T21:05:00Z', comment: 'Every pinned model is wholly in VRAM again' },
  }));
  assert.equal(text.split('\n')[0], '✅ Résolu · Pinned model off GPU — http://192.168.2.99:11434');
  assert.match(text, /Every pinned model is wholly in VRAM again/);
  assert.match(text, /Règle pin-vram-spill · durée 1 h 15/);
});

test('a relayed alert gets one resolution notice, then is forgotten', async () => {
  const mem = memoryState();
  const active = [alert()];
  const fetch = fakeFetch([
    [/\/api\/alerts\?status=active/, 200, () => ({ data: { alerts: active } })],
    [/\/api\/alerts\/a1$/, 200, { data: { alert: alert({ status: 'resolved', resolution: { resolvedAt: '2026-09-27T20:30:00Z', resolutionMethod: 'auto-recovery' } }) } }],
    [/sendMessage/, 200, { ok: true, result: {} }],
    [/delivery-status/, 200, { status: 'success' }],
  ]);
  const deps = { fetch, config: CONFIG, token: TOKEN, now: () => NOW, readState: mem.readState, writeState: mem.writeState };

  await run(parseArgs(['--send']), deps);
  assert.ok(mem.box.state.relayed.a1, 'the sent alert is tracked');

  active.length = 0; // Core resolved it
  const summary = await run(parseArgs(['--send']), deps);
  assert.equal(summary.resolved, 1);
  const notices = fetch.calls.filter((c) => /sendMessage/.test(c.url)).map((c) => c.body.text);
  assert.match(notices[1], /^✅ Résolu/);
  assert.deepEqual(mem.box.state.relayed, {});

  await run(parseArgs(['--send']), deps);
  assert.equal(fetch.calls.filter((c) => /sendMessage/.test(c.url)).length, 2, 'no second notice');
});

test('resolution notices wait for the end of quiet hours; stale tracking expires', async () => {
  const night = Date.parse('2026-09-28T06:00:00Z');
  const mem = memoryState({ relayed: {
    a1: { ruleId: 'pin-vram-spill', sentAt: '2026-09-28T05:00:00Z' },
    old: { ruleId: 'x', sentAt: '2026-09-10T00:00:00Z' },
  } });
  const fetch = fakeFetch([
    [/\/api\/alerts\?status=active/, 200, { data: { alerts: [] } }],
    [/\/api\/alerts\/a1$/, 200, { data: { alert: alert({ status: 'resolved' }) } }],
  ]);
  const config = { ...CONFIG, quietHours: QUIET };
  const summary = await run(parseArgs(['--send']), { fetch, config, token: TOKEN, now: () => night, readState: mem.readState, writeState: mem.writeState });
  assert.equal(summary.quiet, true);
  assert.equal(summary.resolved, 0);
  assert.ok(mem.box.state.relayed.a1, 'held for later');
  assert.equal(mem.box.state.relayed.old, undefined, 'expired after 7 days');
});

test('preview never writes state', async () => {
  const mem = memoryState({ relayed: { a1: { ruleId: 'pin-vram-spill', sentAt: '2026-09-27T19:55:00Z' } } });
  const fetch = fakeFetch([
    [/\/api\/alerts\?status=active/, 200, { data: { alerts: [] } }],
    [/\/api\/alerts\/a1$/, 200, { data: { alert: alert({ status: 'resolved' }) } }],
  ]);
  const summary = await run(parseArgs([]), { fetch, config: CONFIG, now: () => NOW, readState: mem.readState, writeState: mem.writeState });
  assert.match(summary.items[0].preview, /^✅ Résolu/);
  assert.equal(mem.box.writes, 0);
});
