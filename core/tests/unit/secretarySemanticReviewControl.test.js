'use strict';
const { randomUUID } = require('node:crypto');
const { SecretaryPreservationControl } = require('../../integrations/runtime-bridges/secretary-preservation-control');
const input = () => ({ requestId: randomUUID(), messageId: 'a'.repeat(16), threadId: 'b'.repeat(16), sourceSha256: 'c'.repeat(64) });

test('native semantic inventory and bounded page use only the operator-selected copy and exact source', async () => {
  const primary = { available: true, call: jest.fn(async value => value) }, mirror = { available: true, call: jest.fn(async value => value) };
  const control = new SecretaryPreservationControl({ primary, mirror }), selected = input();
  const prefix = `semantic-review --message ${selected.messageId} --thread ${selected.threadId} --sha256 ${selected.sourceSha256} --request-id ${selected.requestId}`;
  expect(await control.probeSemanticReview('primary', selected)).toBe(prefix);
  expect(await control.probeSemanticReview('mirror', { ...selected, resource: 2, offset: 32768 })).toBe(prefix + ' --resource 2 --offset 32768');
  expect(await control.probeSemanticReview('primary', { ...selected, resource: 0 })).toBe(prefix + ' --resource 0 --offset 0');
  expect(primary.call).toHaveBeenCalledTimes(2); expect(mirror.call).toHaveBeenCalledTimes(1);
});

test.each([
  { resource: -1 }, { resource: 256 }, { resource: true }, { resource: '0' }, { offset: 0 },
  { resource: 0, offset: -1 }, { resource: 0, offset: true }, { resource: 0, offset: 16777217 },
  { resource: 0, offset: '0;run' }, { path: '/private' }, { host: 'elsewhere' }, { actor: 'owner' },
  { messageId: 'abc$(run)' }, { threadId: 'a --root /private' }, { sourceSha256: 'A'.repeat(64) }, { requestId: 'x;run' },
])('invalid selectors cannot reach native transport: %j', async extra => {
  const call = jest.fn(), control = new SecretaryPreservationControl({ primary: { available: true, call } });
  await expect(control.probeSemanticReview('primary', { ...input(), ...extra })).rejects.toMatchObject({ statusCode: 400 });
  expect(call).not.toHaveBeenCalled();
});

test('unconfigured mirror never falls back to primary and invalid copy never invokes a reader', async () => {
  const call = jest.fn(), control = new SecretaryPreservationControl({ primary: { available: true, call } });
  control.mirror = null;
  await expect(control.probeSemanticReview('mirror', input())).rejects.toMatchObject({ statusCode: 503 });
  await expect(control.probeSemanticReview('__proto__', input())).rejects.toMatchObject({ statusCode: 400 });
  await expect(control.probeSemanticReview('primary', null)).rejects.toMatchObject({ statusCode: 400 });
  expect(call).not.toHaveBeenCalled();
});
