const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const review = require('../../scripts/coding-advisory-review');

describe('consultative coding review', () => {
  let root, argv;
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'coding-advice-'));
    fs.writeFileSync(path.join(root, 'packet.json'), JSON.stringify({ schema: 'agentx.coding-advisory-packet/v1',
      pipelineId: '0700', attempt: 1, spec: 'repair sum', baseRevision: 'a'.repeat(40),
      workerReceiptFingerprint: 'b'.repeat(64), candidateModel: 'candidate', scope: ['sum.js'],
      authority: [{ path: 'sum.js', content: 'old source' }], changes: [{ path: 'sum.js', content: 'fixed source' }],
      verification: { status: 'passed', profile: 'bounded-unit/v1' } }));
    argv = ['--packet', path.join(root, 'packet.json'), '--out', path.join(root, 'report'), '--model', 'candidate', '--host-url', 'http://host:11434'];
  });
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  test('receipts stay advisory, preserve usage and prevent another call after completion', async () => {
    const infer = jest.fn(async () => ({ model: 'candidate', done: true, prompt_eval_count: 42, eval_count: 8,
      message: { content: 'Check the negative input case in sum.js.' } }));
    const open = jest.fn(async () => ({ infer, close: jest.fn() }));
    const receipt = await review.run(argv, { open });
    expect(receipt).toMatchObject({ advisoryOnly: true, selfReview: true, status: 'completed',
      usage: { effectiveModel: 'candidate', inputTokens: 42, outputTokens: 8, modelCalls: 1 } });
    expect(open).toHaveBeenCalledWith(expect.objectContaining({ purpose: 'coding-advisory-review' }));
    expect(infer.mock.calls[0][0][0].content).toContain('Never claim to run tests');
    await expect(review.run(argv, { open })).rejects.toThrow('receipt exists');
    expect(infer).toHaveBeenCalledTimes(1);
  });

  test.each(['busy', 'stop'])('%s failure is recorded without retry or Pipeline writes', async replay => {
    const infer = jest.fn(async () => { throw Object.assign(new Error('capacity or terminal proof missing'), { replay }); });
    const receipt = await review.run(argv, { open: async () => ({ infer, close: jest.fn() }) });
    expect(receipt.status).toBe(replay === 'busy' ? 'deferred_before_dispatch' : 'unknown');
    expect(receipt.usage.modelCalls).toBe(replay === 'busy' ? 0 : null);
    expect(infer).toHaveBeenCalledTimes(1);
  });

  test('dry run grants no model call and refuses a report inside Git', async () => {
    const open = jest.fn(); expect((await review.run([...argv, '--dry-run'], { open })).status).toBe('not_run');
    expect(open).not.toHaveBeenCalled();
    const inside = [...argv]; inside[3] = path.join(__dirname, 'advice-report');
    await expect(review.run(inside, { open })).rejects.toThrow(/outside|Git/);
  });
});
