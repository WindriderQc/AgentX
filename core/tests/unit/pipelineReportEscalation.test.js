'use strict';

const lean = value => ({ lean: async () => value, select: () => ({ lean: async () => value }) });
const store = { settings: null, runs: [] };

jest.mock('../../models/PipelineReportContinuation', () => ({
  findById: jest.fn(() => lean(store.settings)),
  findOneAndUpdate: jest.fn((query, update, options) => {
    if (!store.settings && options.upsert) store.settings = { _id: 'report-continuation', escalation: { revision: 0 } };
    const s = store.settings;
    if (!s || (query['escalation.revision'] !== undefined && s.escalation.revision !== query['escalation.revision'])) return lean(null);
    for (const [key, value] of Object.entries(update.$set)) {
      if (key.startsWith('escalation.')) s.escalation[key.slice(11)] = value;
    }
    s.escalation.revision = (s.escalation.revision || 0) + 1;
    return lean(s);
  })
}));
jest.mock('../../models/PipelineReportRun', () => ({
  find: jest.fn(() => lean(store.runs.filter(run => run.escalationCalls?.length))),
  findById: jest.fn(id => lean(store.runs.find(run => run._id === id))),
  updateOne: jest.fn(async (query, update) => {
    const run = store.runs.find(row => row._id === query._id);
    run.escalationCalls = [...(run.escalationCalls || []), update.$push.escalationCalls];
  })
}));
jest.mock('../../src/services/pipelineReportNotifications', () => ({ publish: jest.fn(async () => 'a') }));

const escalation = require('../../src/services/pipelineReportEscalation');
const notifications = require('../../src/services/pipelineReportNotifications');
const SOL = 'openai/gpt-5.6-sol';
const NEMO = 'openrouter/nvidia/nemotron-3-super-120b-a12b:free';
const grantTask = allow => ({ _id: 't1', pipelineId: '0939', codingReportAuthority: { grants: [{ key: 'g', ...(allow && { allowCloudEscalation: true }) }] } });

beforeEach(() => {
  jest.clearAllMocks();
  store.settings = { _id: 'report-continuation', escalation: { enabled: true, models: [SOL, NEMO], maxCostUsdPerTask: 10, revision: 3 } };
  store.runs = [];
});

describe('report cloud escalation policy', () => {
  it('allows a run only when the owner policy and the task grant both allow it, with the remaining cap', async () => {
    expect(await escalation.forRun(grantTask(false))).toBeUndefined();
    store.runs = [{ _id: 'old', taskId: 't1', escalationCalls: [{ nanodollars: 2.5e9 }] }];
    expect(await escalation.forRun(grantTask(true))).toEqual({ models: [SOL, NEMO], maxCostNanodollars: 7.5e9, policyRevision: 3 });
    store.settings.escalation.enabled = false;
    expect(await escalation.forRun(grantTask(true))).toBeUndefined();
    store.settings.escalation.enabled = true;
    store.runs = [{ _id: 'old', taskId: 't1', escalationCalls: [{ nanodollars: 10e9 }] }];
    expect(await escalation.forRun(grantTask(true))).toBeUndefined();
  });

  it('refuses a model the run did not record or a spent cap', () => {
    const run = { escalation: { models: [SOL, NEMO], maxCostNanodollars: 1e9 }, escalationCalls: [] };
    expect(escalation.assertCall(run, NEMO)).toBe(1e9);
    expect(() => escalation.assertCall(run, 'openai/gpt-other')).toThrow('does not allow that escalation model');
    expect(() => escalation.assertCall({ ...run, escalationCalls: [{ nanodollars: 1e9 }] }, SOL)).toThrow('cost cap is reached');
    expect(() => escalation.assertCall({ model: 'local' }, SOL)).toThrow('does not allow');
  });

  it('falls back in order when OpenClaw refuses a model, and journals the model that answered and its cost', async () => {
    store.runs = [{ _id: 'r1', escalation: { models: [SOL, NEMO], maxCostNanodollars: 5e9 }, escalationCalls: [] }];
    const calls = [];
    const run = jest.fn(async inference => {
      calls.push(inference);
      if (inference.model === `openclaw:model:${SOL}`) throw Object.assign(new Error('unqualified'), { code: 'OPENCLAW_MODEL_TRANSPORT_UNQUALIFIED' });
      return { ok: true, body: { message: { role: 'assistant', content: '{"documents":[]}' }, done_reason: 'stop' },
        metadata: { receipt: { cost: { nanodollars: 1234, source: 'runtime-estimate' }, billing: { kind: 'free' }, usage: { input: 9, output: 3 } } } };
    });
    const answered = await escalation.execute({ identity: { requestId: 'r1', pipelineId: '0939', callId: 'c1', step: 4, model: SOL },
      messages: [{ role: 'user', content: 'x' }], maxTokens: 8192, requestId: 'c1', remainingNanodollars: 5e9 }, { run });
    expect(answered.model).toBe(NEMO);
    expect(calls.map(call => call.model)).toEqual([`openclaw:model:${SOL}`, `openclaw:model:${NEMO}`]);
    expect(calls[1].budget).toEqual({ maxCalls: 1, maxCostNanodollars: 5e9 });
    expect(store.runs[0].escalationCalls[0]).toMatchObject({ callId: 'c1', step: 4, model: NEMO, nanodollars: 1234,
      attempts: [{ model: SOL, code: 'OPENCLAW_MODEL_TRANSPORT_UNQUALIFIED' }] });
    expect(notifications.publish).toHaveBeenCalledWith({ pipelineId: '0939' }, 'escalated', 'r1', expect.objectContaining({ model: NEMO, step: 4 }));
  });

  it('fails plainly when no model answers, journaling nothing', async () => {
    store.runs = [{ _id: 'r1', escalation: { models: [SOL, NEMO], maxCostNanodollars: 5e9 }, escalationCalls: [] }];
    const run = jest.fn(async () => ({ ok: false, status: 503, body: { error: { code: 'OPENCLAW_UNAVAILABLE' } } }));
    await expect(escalation.execute({ identity: { requestId: 'r1', pipelineId: '0939', callId: 'c1', step: 2, model: SOL },
      messages: [], maxTokens: 10, requestId: 'c1', remainingNanodollars: 5e9 }, { run })).rejects.toMatchObject({ code: 'REPORT_ESCALATION_UNAVAILABLE' });
    expect(run).toHaveBeenCalledTimes(2);
    expect(store.runs[0].escalationCalls).toEqual([]);
  });

  it('changes the policy only with confirmation, valid models and cap, and the current revision', async () => {
    await expect(escalation.configure({ enabled: true })).rejects.toThrow('Confirm');
    await expect(escalation.configure({ enabled: true, confirm: true, expectedRevision: 3, models: ['not a model'] })).rejects.toThrow('provider/model');
    await expect(escalation.configure({ enabled: true, confirm: true, expectedRevision: 3, maxCostUsdPerTask: 5000 })).rejects.toThrow('between 0 and 1000');
    await expect(escalation.configure({ enabled: true, confirm: true, expectedRevision: 1 })).rejects.toThrow('changed');
    await expect(escalation.configure({ enabled: false, confirm: true, expectedRevision: 3, maxCostUsdPerTask: 4 }))
      .resolves.toMatchObject({ enabled: false, maxCostUsdPerTask: 4, revision: 4 });
  });
});

describe('escalation policy display', () => {
  it('says what is on, in which order and with which cap', () => {
    const ui = require('../../public/js/pipeline-report-continuation');
    expect(ui.escalationText({ enabled: true, models: [SOL, NEMO], maxCostUsdPerTask: 10 }))
      .toBe(`On · ${SOL} → ${NEMO} · cap $10.00 per task · only tasks whose grant allows it`);
    expect(ui.escalationText({ enabled: false, models: [], maxCostUsdPerTask: 10 })).toMatch(/^Off · failed steps stay on the local model/);
  });
});
