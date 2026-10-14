'use strict';
jest.mock('../../src/services/clusterScheduleService', () => ({syncEntries: jest.fn(async () => ({}))}));
const {createOperationsService, projectSnapshot} = require('../../src/services/operationsJobsService');
const id = '12345678-1234-4234-8234-123456789012';
const snapshot = () => ({contract: 'agentx.operations/v1', revision: 1, available: true, observedAt: '2026-01-01T00:00:00Z',
  supervisor: {label: 'Server', lastTickAt: '2026-01-01T00:00:00Z'}, jobs: [{id: 'usage', name: 'Usage', kind: 'codex-usage', enabled: true,
    schedule: {type: 'interval', minutes: 15, timezone: 'UTC'}, state: 'never', hostLabel: 'Workstation', options: {token: 'private'}, path: '/private/root'}],
  history: [], inventory: {rows: []}});
const env = {AGENTX_OPERATIONS_SSH_TARGET: 'operator@server', AGENTX_OPERATIONS_ROOT: '/private/state', AGENTX_OPERATIONS_CONTROL: '/opt/agentx/control.py'};
const runnerFor = data => jest.fn(async () => ({stdout: JSON.stringify({status: 'success', data})}));

test('an unconfigured instance exposes an explicit empty state without SSH or Mongo', async () => {
  const runner = jest.fn();
  const service = createOperationsService({env: {}, runner});
  expect(await service.status()).toMatchObject({available: false, code: 'NOT_CONFIGURED'});
  expect(runner).not.toHaveBeenCalled();
});
test('status strips private paths/options and mirrors only the projected snapshot', async () => {
  const runner = runnerFor(snapshot()), mirror = jest.fn();
  const service = createOperationsService({env, runner, mirror});
  const data = await service.status();
  expect(JSON.stringify(data)).not.toContain('private');
  expect(mirror).toHaveBeenCalledWith(data);
  expect(runner.mock.calls[0][1]).toContain("python3 '/opt/agentx/control.py' --root '/private/state' status");
  await service.status();
  expect(runner).toHaveBeenCalledTimes(1);
});
test('the cluster timeline retains the native recurrence anchor after a manual run', async () => {
  const native = snapshot();
  native.jobs[0].nextRunAt = '2026-01-01T00:16:27Z';
  native.jobs[0].lastRun = {requestId: id, jobId: 'usage', state: 'completed', startedAt: '2026-01-01T00:05:00Z'};
  await createOperationsService({env, runner: runnerFor(native)}).status();
  const entries = require('../../src/services/clusterScheduleService').syncEntries.mock.calls.at(-1)[0];
  expect(entries[0].metadata.nextRunAtMs).toBe(Date.parse(native.jobs[0].nextRunAt));
});
test('a run retains its exact identity and revision through the named native entrance', async () => {
  const runner = runnerFor({requestId: id, jobId: 'usage', state: 'accepted'});
  const service = createOperationsService({env, runner, mirror: jest.fn()});
  expect(await service.run('usage', {requestId: id, revision: 3})).toMatchObject({requestId: id, state: 'accepted'});
  expect(runner.mock.calls[0][1]).toContain(`'--request' '${id}' '--revision' '3'`);
});
test('arbitrary commands, traversal, invalid identities and extra fields refuse before SSH', async () => {
  const runner = jest.fn(), service = createOperationsService({env, runner});
  for (const [job, body] of [['../../job', {requestId: id, revision: 1}], ['usage', {requestId: 'new', revision: 1}], ['usage', {requestId: id, revision: 1, command: 'anything'}]]) {
    await expect(service.run(job, body)).rejects.toMatchObject({status: 400});
  }
  await expect(service.patch('usage', {revision: 1, command: 'anything'})).rejects.toMatchObject({status: 400});
  await expect(service.patch('usage', {revision: 1, schedule: {type: 'interval', minutes: 15, command: 'anything'}})).rejects.toMatchObject({status: 400});
  expect(runner).not.toHaveBeenCalled();
});
test('a lost native reply exposes unknown without sending a replacement', async () => {
  const runner = jest.fn(async () => {throw Error('private connection details');});
  const service = createOperationsService({env, runner});
  await expect(service.run('usage', {requestId: id, revision: 1})).rejects.toMatchObject({code: 'NATIVE_OUTCOME_UNKNOWN'});
  expect(runner).toHaveBeenCalledTimes(1);
});
test('native revision refusal stays a conflict and settings are encoded rather than interpolated', async () => {
  const runner = jest.fn(async () => ({stdout: JSON.stringify({status: 'error', error: {code: 'REVISION_CONFLICT', message: 'Refresh', status: 409}})}));
  const service = createOperationsService({env, runner});
  await expect(service.patch('usage', {revision: 1, enabled: false})).rejects.toMatchObject({status: 409, code: 'REVISION_CONFLICT'});
  const command = runner.mock.calls[0][1];
  expect(command).toContain(Buffer.from('{"enabled":false}').toString('base64'));
  expect(command).not.toContain('"enabled"');
});
test('an unexpected native protocol cannot silently become a healthy empty list', () => {
  expect(() => projectSnapshot({jobs: []})).toThrow('incomplete');
});
