const {
  RECEIPT_SCHEMA, parseActuators, createActuatorClient, sshArgs, lastReceipt
} = require('../../src/services/runtimeTopologyActuator');

const RAW = JSON.stringify({
  'dual-gpu': {
    sshTarget: 'agentx-topology@gpu-host',
    keyPath: '/run/agentx/topology-actuator/id_ed25519',
    knownHostsPath: '/run/agentx/topology-actuator/known_hosts'
  }
});

function receipt(extra = {}) {
  return { schema: RECEIPT_SCHEMA, command: 'activate', outcome: 'activated', ...extra };
}

describe('runtime topology actuator client', () => {
  it('parses per-group targets and rejects anything malformed without echoing it', () => {
    const parsed = parseActuators(RAW);
    expect(parsed.get('dual-gpu')).toMatchObject({ sshTarget: 'agentx-topology@gpu-host', port: 22 });
    expect(parseActuators('').size).toBe(0);
    const bad = [
      '{', '[]', JSON.stringify({ g: { sshTarget: 'root@h; rm -rf /', keyPath: '/k', knownHostsPath: '/h' } }),
      JSON.stringify({ g: { sshTarget: 'a@h', keyPath: 'relative', knownHostsPath: '/h' } }),
      JSON.stringify({ g: { sshTarget: 'a@h', keyPath: '/k', knownHostsPath: '/h', extra: 1 } }),
      JSON.stringify({ g: { sshTarget: 'a@h', keyPath: '/k', knownHostsPath: '/h', timeoutsMs: { activate: 10 } } })
    ];
    for (const raw of bad) {
      let error;
      try { parseActuators(raw); } catch (caught) { error = caught; }
      expect(error?.code).toBe('topology_actuator_configuration_invalid');
      expect(error.message).not.toContain('rm -rf');
    }
  });

  it('always checks the host key and uses only the dedicated key', () => {
    const args = sshArgs(parseActuators(RAW).get('dual-gpu'), 'status');
    expect(args).toEqual(expect.arrayContaining([
      'BatchMode=yes', 'StrictHostKeyChecking=yes', 'IdentitiesOnly=yes',
      'UserKnownHostsFile=/run/agentx/topology-actuator/known_hosts'
    ]));
    expect(args.slice(-2)).toEqual(['agentx-topology@gpu-host', 'status']);
  });

  it('sends the closed command words and returns the receipt', async () => {
    const calls = [];
    const client = createActuatorClient({
      readRaw: () => RAW,
      runner: async (args, options) => {
        calls.push({ command: args[args.length - 1], timeoutMs: options.timeoutMs });
        return { exitCode: 0, stdout: `noise\n${JSON.stringify(receipt({ requestId: 'sw-1' }))}\n`, timedOut: false };
      }
    });
    const result = await client.activate('dual-gpu', 'lanes', 'sw-1');
    expect(result).toMatchObject({ transport: 'ok', outcome: 'activated', receipt: { requestId: 'sw-1' } });
    await client.confirm('dual-gpu', 'sw-1');
    await client.rollback('dual-gpu', 'sw-1-rb', 'verify_failed');
    await client.status('dual-gpu', 'sw-1');
    expect(calls.map(call => call.command)).toEqual([
      'activate lanes --request-id sw-1', 'confirm --request-id sw-1',
      'rollback --request-id sw-1-rb --reason verify_failed', 'status --request-id sw-1'
    ]);
    expect(calls[0].timeoutMs).toBe(15 * 60_000);
  });

  it('refuses unsafe words before running anything', () => {
    const client = createActuatorClient({ readRaw: () => RAW, runner: async () => { throw new Error('ran'); } });
    expect(() => client.activate('dual-gpu', 'lanes; reboot', 'sw-1')).toThrow('Invalid mode');
    expect(() => client.confirm('dual-gpu', 'a b')).toThrow('Invalid actuator request id');
    expect(() => client.rollback('dual-gpu', 'sw', 'Bad Reason')).toThrow('Invalid reason');
  });

  it('distinguishes unreachable, timeout and missing receipts as unknown outcomes', async () => {
    const make = result => createActuatorClient({ readRaw: () => RAW, runner: async () => result });
    expect(await make({ exitCode: 255, stdout: '', timedOut: false }).status('dual-gpu'))
      .toMatchObject({ transport: 'unreachable', outcome: 'unknown' });
    expect(await make({ exitCode: null, stdout: '', timedOut: true }).activate('dual-gpu', 'lanes', 'sw-1'))
      .toMatchObject({ transport: 'timeout', outcome: 'unknown' });
    expect(await make({ exitCode: 1, stdout: 'not json', timedOut: false }).status('dual-gpu'))
      .toMatchObject({ transport: 'bad_receipt', outcome: 'unknown' });
    expect(await make({ exitCode: 1, stdout: JSON.stringify(receipt({ outcome: 'failed' })), timedOut: false })
      .activate('dual-gpu', 'lanes', 'sw-1')).toMatchObject({ transport: 'ok', outcome: 'failed' });
  });

  it('reports a group without an actuator as not configured', async () => {
    const client = createActuatorClient({ readRaw: () => RAW, runner: async () => { throw new Error('ran'); } });
    expect(client.configured('other')).toBe(false);
    expect(await client.status('other')).toMatchObject({ transport: 'not_configured', reason: 'topology_actuator_not_configured' });
    const broken = createActuatorClient({ readRaw: () => '{', runner: async () => ({}) });
    expect(broken.configurationError('dual-gpu')).toBe('topology_actuator_configuration_invalid');
  });

  it('finds the receipt on the last schema line only', () => {
    expect(lastReceipt('{"a":1}\n')).toBeNull();
    expect(lastReceipt(`${JSON.stringify(receipt({ n: 1 }))}\n${JSON.stringify(receipt({ n: 2 }))}`).n).toBe(2);
  });
});
