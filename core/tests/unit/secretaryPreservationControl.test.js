'use strict';

const { randomUUID } = require('node:crypto');
const { SecretaryMailControl } = require('../../integrations/runtime-bridges/secretary-mail-control');
const { SecretaryPreservationControl } = require('../../integrations/runtime-bridges/secretary-preservation-control');

const input = () => ({ requestId: randomUUID(), messageId: '1234567890abcdef', threadId: '1234567890abcdea', sourceSha256: 'a'.repeat(64) });

test.each(['preservation', 'restoration'])('both operator-selected readers use the bounded native %s command', async command => {
  const calls = [];
  const reader = target => new SecretaryMailControl({ sshTarget: target, remoteRoot: '/opt/product',
    sshRunner: async (host, command) => { calls.push({ host, command }); return { stdout: JSON.stringify({ status: 'success', data: { observed: true } }) }; } });
  const control = new SecretaryPreservationControl({ primary: reader('primary.example.invalid'), mirror: reader('mirror.example.invalid') });
  const request = input();
  const read = command === 'restoration' ? control.probeRestoration.bind(control) : control.probe.bind(control);
  await read('primary', request); await read('mirror', request);
  expect(calls.map(call => call.host)).toEqual(['primary.example.invalid', 'mirror.example.invalid']);
  for (const call of calls) expect(call.command).toBe(`/usr/bin/python3 /opt/product/integrations/secretary/secretary_mail_desk.py ${command} --message ${request.messageId} --thread ${request.threadId} --sha256 ${request.sourceSha256} --request-id ${request.requestId}`);
});

test.each(['probe', 'probeRestoration'])('an unconfigured mirror cannot silently select the primary host in %s', async method => {
  const oldTarget = process.env.SECRETARY_ARCHIVE_MIRROR_SSH_TARGET;
  const oldRoot = process.env.SECRETARY_ARCHIVE_MIRROR_REMOTE_ROOT;
  delete process.env.SECRETARY_ARCHIVE_MIRROR_SSH_TARGET; delete process.env.SECRETARY_ARCHIVE_MIRROR_REMOTE_ROOT;
  try {
    const call = jest.fn();
    const control = new SecretaryPreservationControl({ primary: { available: true, call } });
    await expect(control[method]('mirror', input())).rejects.toMatchObject({ code: 'SECRETARY_PRESERVATION_UNAVAILABLE' });
    expect(call).not.toHaveBeenCalled();
  } finally {
    if (oldTarget === undefined) delete process.env.SECRETARY_ARCHIVE_MIRROR_SSH_TARGET; else process.env.SECRETARY_ARCHIVE_MIRROR_SSH_TARGET = oldTarget;
    if (oldRoot === undefined) delete process.env.SECRETARY_ARCHIVE_MIRROR_REMOTE_ROOT; else process.env.SECRETARY_ARCHIVE_MIRROR_REMOTE_ROOT = oldRoot;
  }
});

test.each([
  { requestId: 'x;run' }, { messageId: 'abc$(run)' }, { threadId: 'abc --root elsewhere' }, { sourceSha256: 'A'.repeat(64) },
])('rejects shell-shaped or invalid identities before transport', async extra => {
  const call = jest.fn();
  const control = new SecretaryPreservationControl({ primary: { available: true, call } });
  await expect(control.probe('primary', { ...input(), ...extra })).rejects.toMatchObject({ statusCode: 400 });
  await expect(control.probeRestoration('primary', { ...input(), ...extra })).rejects.toMatchObject({ statusCode: 400 });
  expect(call).not.toHaveBeenCalled();
});
