jest.mock('../../src/services/roundtable/orchestrator', () => ({
  runRoundtable: jest.fn(),
  createRoundtable: jest.fn(),
  cancelRoundtable: jest.fn(),
  getRoundtable: jest.fn(),
  listRoundtables: jest.fn(),
  reconcileStaleRoundtables: jest.fn(),
  emitterRegistry: new Map()
}));

const orchestrator = require('../../src/services/roundtable/orchestrator');
const roundtable = require('../../src/services/roundtable');

const options = {
  question: 'Ship it?',
  panel: [{ agentId: 'critic', role: 'Critic', model: 'model-a' }],
  synthesizer: { model: 'model-a' }
};

describe('one Council at a time', () => {
  test('a second start while one runs is refused with 409, then allowed once it ends', async () => {
    let finish;
    orchestrator.runRoundtable.mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    orchestrator.createRoundtable
      .mockResolvedValueOnce({ _id: 'aaaaaaaaaaaaaaaaaaaaaaaa' })
      .mockResolvedValueOnce({ _id: 'bbbbbbbbbbbbbbbbbbbbbbbb' });
    orchestrator.getRoundtable.mockResolvedValue({ status: 'completed' });

    await roundtable.startRoundtable(options);
    await expect(roundtable.startRoundtable(options)).rejects.toMatchObject({
      status: 409, code: 'COUNCIL_ACTIVE', activeId: 'aaaaaaaaaaaaaaaaaaaaaaaa'
    });
    expect(orchestrator.createRoundtable).toHaveBeenCalledTimes(1);

    finish();
    await new Promise((resolve) => setImmediate(resolve));
    expect(roundtable.getActiveRoundtableId()).toBeNull();
    await expect(roundtable.startRoundtable(options)).resolves.toMatchObject({ _id: 'bbbbbbbbbbbbbbbbbbbbbbbb' });
    finish();
  });

  test('two starts sent together create one Council', async () => {
    await new Promise((resolve) => setImmediate(resolve));
    orchestrator.createRoundtable.mockReset().mockResolvedValue({ _id: 'cccccccccccccccccccccccc' });
    orchestrator.runRoundtable.mockImplementation(() => new Promise(() => {}));
    const results = await Promise.allSettled([roundtable.startRoundtable(options), roundtable.startRoundtable(options)]);
    expect(results.map((r) => r.status).sort()).toEqual(['fulfilled', 'rejected']);
    expect(orchestrator.createRoundtable).toHaveBeenCalledTimes(1);
  });
});
