'use strict';

const { randomUUID } = require('node:crypto');
const { SecretaryMailControl } = require('../../integrations/runtime-bridges/secretary-mail-control');
const { SecretaryFindingsControl } = require('../../integrations/runtime-bridges/secretary-findings-control');
const input = () => ({ requestId: randomUUID(), messageId: '1234567890abcdef', threadId: '1234567890abcdea', sourceSha256: 'a'.repeat(64) });

test('recorded finding transport reuses the operator-selected native mail reader without host/path arguments', async () => {
  const calls = [], reader = new SecretaryMailControl({ sshTarget: 'archive.example.invalid', remoteRoot: '/opt/product',
    sshRunner: async (host, command) => { calls.push({ host, command }); return { stdout: JSON.stringify({ status: 'success', data: { observed: true } }) }; } });
  const control = new SecretaryFindingsControl({ reader }), value = input();
  expect(await control.probe(value)).toEqual({ observed: true });
  expect(calls).toEqual([{ host: 'archive.example.invalid', command: `/usr/bin/python3 /opt/product/integrations/secretary/secretary_mail_desk.py findings --message ${value.messageId} --thread ${value.threadId} --sha256 ${value.sourceSha256} --request-id ${value.requestId}` }]);
});

test.each([{ requestId: ['00000000-0000-4000-8000-000000000001'] }, { sourceSha256: ['a'.repeat(64)] },
  { threadId: 'abc --root elsewhere' }, { messageId: 'abc$(run)' }, { requestId: 'invalid' }])('invalid native finding argument refuses before transport: %p', async change => {
  const call = jest.fn(), control = new SecretaryFindingsControl({ reader: { available: true, call } });
  await expect(control.probe({ ...input(), ...change })).rejects.toMatchObject({ statusCode: 400 }); expect(call).not.toHaveBeenCalled();
});

test('an unconfigured producer remains unavailable and never calls any fallback', async () => {
  const call = jest.fn(), control = new SecretaryFindingsControl({ reader: { available: false, call } });
  await expect(control.probe(input())).rejects.toMatchObject({ code: 'SECRETARY_FINDINGS_UNAVAILABLE' }); expect(call).not.toHaveBeenCalled();
});
