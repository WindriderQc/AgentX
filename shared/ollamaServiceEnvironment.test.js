'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  OLLAMA_ENV_KEYS,
  normalizeOllamaEnvironment,
  parseSystemdShow,
  parseWindowsEnvironment,
  pickAllowed,
  splitSystemdWords,
  systemdShowArgs,
} = require('./ollamaServiceEnvironment');

test('systemd words honour quotes, escapes and repeated spaces', () => {
  assert.deepEqual(
    splitSystemdWords('A=1  "B=two words" \'C=x y\' D=a\\ b "E=say \\"hi\\""'),
    ['A=1', 'B=two words', 'C=x y', 'D=a b', 'E=say "hi"']
  );
  assert.deepEqual(splitSystemdWords(''), []);
  assert.deepEqual(splitSystemdWords('EMPTY=""'), ['EMPTY=']);
});

test('only allowlisted keys with plain values are kept; the last assignment wins', () => {
  const { values, rejectedKeys } = pickAllowed([
    ['OLLAMA_KV_CACHE_TYPE', 'f16'],
    ['OLLAMA_KV_CACHE_TYPE', 'q8_0'],
    ['CUDA_VISIBLE_DEVICES', ''],
    ['OLLAMA_KEEP_ALIVE', '$(reboot)'],
    ['HF_TOKEN', 'synthetic-secret'],
  ]);
  assert.deepEqual(values, { OLLAMA_KV_CACHE_TYPE: 'q8_0', CUDA_VISIBLE_DEVICES: '' });
  assert.deepEqual(rejectedKeys, ['OLLAMA_KEEP_ALIVE']);
  assert.ok(OLLAMA_ENV_KEYS.includes('OLLAMA_FLASH_ATTENTION'));
});

test('systemctl show is parsed into an observation', () => {
  const observation = parseSystemdShow([
    'LoadState=loaded',
    'ActiveState=active',
    'ExecMainStartTimestamp=Sat 2026-10-03 21:14:02 EDT',
    'NeedDaemonReload=yes',
    'Environment="OLLAMA_HOST=0.0.0.0" OLLAMA_KV_CACHE_TYPE=q8_0 OLLAMA_MAX_LOADED_MODELS=2',
    'EnvironmentFiles=/etc/default/ollama (ignore_errors=no)',
  ].join('\n'), 'ollama.service');
  assert.deepEqual(observation, {
    source: 'systemd',
    unit: 'ollama.service',
    ok: true,
    values: { OLLAMA_KV_CACHE_TYPE: 'q8_0', OLLAMA_MAX_LOADED_MODELS: '2' },
    rejectedKeys: [],
    activeState: 'active',
    activeSince: 'Sat 2026-10-03 21:14:02 EDT',
    needDaemonReload: true,
    environmentFiles: true,
  });
  assert.throws(() => parseSystemdShow('LoadState=not-found\n', 'ollama.service'), /not found/);
  assert.throws(() => parseSystemdShow('', 'ollama.service'), /no unit properties/);
});

test('systemctl arguments only accept a plain unit name', () => {
  assert.equal(systemdShowArgs('ollama.service')[1], 'ollama.service');
  for (const unit of ['', '-H host', 'ollama.service; reboot', 'a b']) {
    assert.throws(() => systemdShowArgs(unit), /unit name/);
  }
});

test('the Windows user environment overrides the machine environment, case-insensitively', () => {
  const machine = 'HKEY_LOCAL_MACHINE\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment\r\n' +
    '    OLLAMA_FLASH_ATTENTION    REG_SZ    1\r\n    OLLAMA_NUM_PARALLEL    REG_SZ    2\r\n';
  const user = 'HKEY_CURRENT_USER\\Environment\r\n    ollama_num_parallel    REG_SZ    4\r\n' +
    '    CUDA_VISIBLE_DEVICES    REG_SZ    \r\n    Path    REG_EXPAND_SZ    C:\\Users\\x\r\n';
  const observation = parseWindowsEnvironment(machine, user);
  assert.equal(observation.source, 'windows-registry');
  assert.deepEqual(observation.values, { OLLAMA_FLASH_ATTENTION: '1', OLLAMA_NUM_PARALLEL: '4', CUDA_VISIBLE_DEVICES: '' });
});

test('normalization drops unknown keys and malformed observations', () => {
  assert.equal(normalizeOllamaEnvironment(null), null);
  assert.equal(normalizeOllamaEnvironment({ source: 'docker', ok: true, observedAt: '2026-10-04T00:00:00Z' }), null);
  assert.equal(normalizeOllamaEnvironment({ source: 'systemd', ok: true, observedAt: 'yesterday' }), null);
  const normalized = normalizeOllamaEnvironment({
    source: 'systemd', unit: 'ollama.service; reboot', ok: true, observedAt: '2026-10-04T00:00:00Z',
    values: { OLLAMA_SCHED_SPREAD: 'true', SECRET: 'x' }, rejectedKeys: ['SECRET', 'OLLAMA_KEEP_ALIVE'],
    activeState: 'Active!', needDaemonReload: 'no', environmentFiles: false, extra: 'ignored',
  });
  assert.deepEqual(normalized, {
    source: 'systemd', unit: null, observedAt: '2026-10-04T00:00:00.000Z', ok: true,
    values: { OLLAMA_SCHED_SPREAD: 'true' }, rejectedKeys: ['OLLAMA_KEEP_ALIVE'],
    activeState: null, activeSince: null, needDaemonReload: null, environmentFiles: false,
  });
  assert.deepEqual(
    normalizeOllamaEnvironment({ source: 'windows-registry', ok: false, observedAt: '2026-10-04T00:00:00Z', error: 'denied\u0000' }),
    { source: 'windows-registry', unit: null, observedAt: '2026-10-04T00:00:00.000Z', ok: false, error: 'denied' }
  );
});
