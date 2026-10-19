'use strict';

const { buildLaneCapability } = require('../../src/services/profiler/laneCapability');
const { capabilityFor, listLaneCapabilities, requestLaneMeasurement, requestLaneCampaign, previewLaneCampaign } = require('../../src/services/profiler/laneCapabilityService');

const NOW = new Date('2026-10-16T12:00:00Z');
const HOST = 'http://gpu-b:11434';
const MODEL = 'coder:27b-q8_0';
const ARTIFACT = { digest: 'sha256:aaa', runtimeFingerprint: 'rt-1' };

const contextProfile = (over = {}) => ({
  _id: 'ctx1',
  maxVerifiedContext: 262144,
  recommendedInteractiveContext: 65536,
  recommendedDocumentContext: 131072,
  performanceKneeContext: 32768,
  performanceKneeDegradationPct: 15,
  qualityVerifiedContext: null,
  qualityContextStatus: 'unknown',
  recommendationStatus: 'verified',
  modelTheoreticalMax: 262144,
  lastValidatedAt: '2026-10-07T23:00:00Z',
  ...over
});
const performanceProfile = (profile = {}, over = {}) => ({
  _id: 'perf1',
  artifact: { digest: 'sha256:aaa' },
  updatedAt: '2026-10-07T23:02:00Z',
  profile: {
    profileDepth: 'standard',
    tokensPerSec: 53.6,
    promptEvalTokensPerSec: 1450.2,
    ttftP50Ms: 820,
    comparisonNumCtx: 8192,
    profiledAt: '2026-10-07T23:02:00Z',
    ...profile
  },
  ...over
});
const codes = capability => capability.gaps.map(gap => gap.code);

describe('lane capability profile', () => {
  it('assembles context, throughput and provenance from the exact artifact evidence', () => {
    const capability = buildLaneCapability({ model: MODEL, hostUrl: HOST, hostId: 'alien', artifact: ARTIFACT,
      contextProfile: contextProfile(), performanceProfile: performanceProfile(), now: NOW });
    expect(capability.schema).toBe('agentx.lane-capability/v1');
    expect(capability.context).toMatchObject({ max: 262144, interactive: 65536, document: 131072, knee: 32768,
      recommendationStatus: 'verified' });
    expect(capability.throughput).toMatchObject({ generationTokensPerSec: 53.6, promptTokensPerSec: 1450.2,
      ttftP50Ms: 820, measuredAtNumCtx: 8192, longPrefill: [] });
    expect(capability.provenance).toMatchObject({ contextProfileId: 'ctx1', performanceProfileId: 'perf1',
      depth: 'standard', ageDays: 8 });
    expect(capability.readiness).toEqual({ chat: 'ready', documents: 'speed_only', codingAgent: 'not_measured' });
    expect(codes(capability)).toEqual(['quality_unknown', 'long_prefill_missing', 'agent_workload_missing', 'concurrency_unmeasured']);
    expect(capability.gaps.every(gap => typeof gap.text === 'string' && gap.text.length > 10)).toBe(true);
  });

  it('marks documents ready only when verified quality covers the document context', () => {
    const verified = contextProfile({ qualityContextStatus: 'verified', qualityVerifiedContext: 131072 });
    const capability = buildLaneCapability({ model: MODEL, hostUrl: HOST, artifact: ARTIFACT,
      contextProfile: verified, performanceProfile: performanceProfile(), now: NOW });
    expect(capability.quality).toMatchObject({ status: 'verified', context: 131072 });
    expect(capability.readiness.documents).toBe('ready');
    const shorter = buildLaneCapability({ model: MODEL, hostUrl: HOST, artifact: ARTIFACT,
      contextProfile: contextProfile({ qualityContextStatus: 'verified', qualityVerifiedContext: 65536 }),
      performanceProfile: performanceProfile(), now: NOW });
    expect(shorter.readiness.documents).toBe('speed_only');
  });

  it('takes Full-profile quality and long prefill rows for the same artifact', () => {
    const full = performanceProfile({
      profileDepth: 'full', qualityContextStatus: 'verified', qualityVerifiedContext: 65536,
      prefillDecodeMatrix: { longPrefill: { sizes: [
        { numCtx: 131072, status: 'pass', prefillTokensPerSec: 900, ttftMs: 130000 },
        { numCtx: 32768, status: 'pass', prefillTokensPerSec: 1400, ttftMs: 21000 },
        { numCtx: 65536, status: 'skipped', prefillTokensPerSec: null }
      ] } }
    });
    const capability = buildLaneCapability({ model: MODEL, hostUrl: HOST, artifact: ARTIFACT,
      contextProfile: contextProfile(), performanceProfile: full, now: NOW });
    expect(capability.quality).toMatchObject({ status: 'verified', context: 65536 });
    expect(capability.throughput.longPrefill).toEqual([
      { numCtx: 32768, promptTokensPerSec: 1400, ttftMs: 21000 },
      { numCtx: 131072, promptTokensPerSec: 900, ttftMs: 130000 }
    ]);
    expect(codes(capability)).not.toContain('long_prefill_missing');
  });

  it('rejects physically impossible measurements instead of trusting them', () => {
    const capability = buildLaneCapability({ model: MODEL, hostUrl: HOST, artifact: ARTIFACT,
      contextProfile: contextProfile(), performanceProfile: performanceProfile({ tokensPerSec: 1000000 }), now: NOW });
    expect(capability.throughput.generationTokensPerSec).toBeNull();
    expect(capability.rejected).toEqual([{ field: 'throughput.generation', value: 1000000, reason: 'above plausible maximum' }]);
    expect(codes(capability)).toContain('implausible_values');
  });

  it('ignores a performance profile measured on another artifact', () => {
    const capability = buildLaneCapability({ model: MODEL, hostUrl: HOST, artifact: ARTIFACT,
      contextProfile: contextProfile(), performanceProfile: performanceProfile({}, { artifact: { digest: 'sha256:old' } }), now: NOW });
    expect(capability.throughput.generationTokensPerSec).toBeNull();
    expect(capability.provenance.performanceProfileId).toBeNull();
    expect(codes(capability)).toContain('performance_artifact_mismatch');
  });

  it('never presents unverified recommendations or an unidentified artifact as ready', () => {
    const unverified = buildLaneCapability({ model: MODEL, hostUrl: HOST, artifact: ARTIFACT,
      contextProfile: contextProfile({ recommendationStatus: 'unknown', recommendedInteractiveContext: null,
        recommendedDocumentContext: null, performanceKneeContext: null }), now: NOW });
    expect(unverified.readiness).toEqual({ chat: 'unverified', documents: 'unverified', codingAgent: 'not_measured' });
    expect(codes(unverified)).toEqual(expect.arrayContaining(['recommendations_unverified', 'no_performance_profile']));

    const unknown = buildLaneCapability({ model: MODEL, hostUrl: HOST, artifact: null,
      contextProfile: contextProfile(), now: NOW });
    expect(unknown.artifact).toBeNull();
    expect(unknown.context.max).toBeNull();
    expect(unknown.readiness.chat).toBe('not_measured');
    expect(codes(unknown)[0]).toBe('artifact_unresolved');
  });

  it('flags evidence older than thirty days', () => {
    const capability = buildLaneCapability({ model: MODEL, hostUrl: HOST, artifact: ARTIFACT,
      contextProfile: contextProfile({ lastValidatedAt: '2026-08-01T00:00:00Z' }),
      performanceProfile: performanceProfile({ profiledAt: '2026-08-02T00:00:00Z' }), now: NOW });
    expect(capability.provenance.ageDays).toBe(75);
    expect(codes(capability)).toContain('profile_old');
  });
});

describe('lane capability service', () => {
  const hosts = () => [{ id: 'alien', name: 'UG Alien', url: HOST }];

  it('resolves the installed identity once and reads only evidence for it', async () => {
    const identity = jest.fn(async () => ARTIFACT);
    const findContext = jest.fn(async () => contextProfile());
    const findPerformance = jest.fn(async () => performanceProfile());
    const capability = await capabilityFor({ model: MODEL, hostUrl: `${HOST}/` }, {
      hosts, identity, contextProfile: findContext, performanceProfile: findPerformance, now: () => NOW });
    expect(identity).toHaveBeenCalledWith(MODEL, 'alien', HOST);
    expect(findContext).toHaveBeenCalledWith(MODEL, HOST, ARTIFACT);
    expect(findPerformance).toHaveBeenCalledWith(MODEL, 'alien');
    expect(capability.hostId).toBe('alien');
    expect(capability.context.knee).toBe(32768);
  });

  it('uses a caller-supplied identity without touching the host', async () => {
    const identity = jest.fn();
    await capabilityFor({ model: MODEL, hostUrl: HOST, artifact: ARTIFACT }, {
      hosts, identity, contextProfile: async () => null, performanceProfile: async () => null, now: () => NOW });
    expect(identity).not.toHaveBeenCalled();
  });

  it('keeps a lane listed with explicit gaps when its identity cannot be read', async () => {
    const result = await listLaneCapabilities({
      hosts,
      scope: async () => [{ hostUrl: HOST, hostName: 'UG Alien', residency: 'gpu', model: MODEL, pinned: true,
        pinContext: 196608, tasks: ['code_generation'] }],
      identity: async () => { throw new Error('host offline'); },
      contextProfile: async () => contextProfile(),
      performanceProfile: async () => null,
      now: () => NOW
    });
    expect(result.generatedAt).toBe(NOW.toISOString());
    expect(result.lanes).toHaveLength(1);
    expect(result.lanes[0]).toMatchObject({ hostName: 'UG Alien', pinned: true, pinContext: 196608, tasks: ['code_generation'] });
    expect(codes(result.lanes[0].capability)).toEqual(expect.arrayContaining(['artifact_unresolved', 'no_performance_profile']));
  });
});

describe('lane measurement request', () => {
  const hosts = () => [{ id: 'alien', name: 'UG Alien', url: HOST }];
  const scope = async () => [{ hostUrl: HOST, hostName: 'UG Alien', model: MODEL, pinned: true, tasks: [] }];
  const window = { notBefore: '2026-10-17T03:00:00Z', startBefore: '2026-10-17T10:00:00Z' };

  it('records a Full profile of exactly one current lane and starts nothing', async () => {
    const submit = jest.fn(async () => ({ id: 'q1', state: 'requested', revision: 1, extra: 'x' }));
    const reserve = jest.fn(async (id, body) => ({ id, state: 'reserved', revision: 2, reservation: { start: body.start, autoStart: body.autoStart } }));
    const result = await requestLaneMeasurement({ model: MODEL, hostUrl: `${HOST}/`, ...window },
      { hosts, scope, submit, reserve, queue: async () => ({ jobs: [] }), now: () => NOW });
    expect(reserve).toHaveBeenCalledWith('q1', { expectedRevision: 1, start: '2026-10-17T03:00:00.000Z', priority: 5, autoStart: false });
    expect(submit).toHaveBeenCalledTimes(1);
    expect(submit.mock.calls[0][0]).toEqual({
      key: 'lane-capability:alien:coder:27b-q8_0:2026-10-17',
      title: 'Full profile of coder:27b-q8_0 on UG Alien (lane capability)',
      kind: 'profiler', hosts: [HOST], estimatedMinutes: 180, ...{ notBefore: '2026-10-17T03:00:00.000Z', startBefore: '2026-10-17T10:00:00.000Z' },
      source: { type: 'operator', ref: 'profiler-lane-capability-card' },
      executor: { hostId: 'alien', depth: 'full', skipRecentDays: 0, modelNames: [MODEL] }
    });
    expect(result.job).toEqual({ id: 'q1', state: 'reserved', revision: 2 });
    expect(result.slot).toMatchObject({ planned: true, fits: true, end: '2026-10-17T06:00:00.000Z' });
  });

  it.each([
    [{ model: 'other:7b', hostUrl: HOST, ...window }, 'Only a pinned or routed lane'],
    [{ model: MODEL, hostUrl: HOST, notBefore: '2026-10-16T10:00:00Z', startBefore: '2026-10-16T14:00:00Z' }, 'within the next 48 hours'],
    [{ model: MODEL, hostUrl: HOST, notBefore: '2026-10-17T03:00:00Z', startBefore: '2026-10-17T20:00:00Z' }, 'between 1 and 12 hours'],
    [{ model: MODEL, hostUrl: HOST, notBefore: 'tonight', startBefore: window.startBefore }, 'valid time'],
    [{ hostUrl: HOST, ...window }, 'model and hostUrl are required']
  ])('refuses %o without submitting', async (input, message) => {
    const submit = jest.fn();
    await expect(requestLaneMeasurement(input, { hosts, scope, submit, queue: async () => ({ jobs: [] }), now: () => NOW })).rejects.toThrow(message);
    expect(submit).not.toHaveBeenCalled();
  });
});

describe('agent workload in the lane profile', () => {
  const agentWorkload = (summary = {}, turns = []) => ({ measuredAt: '2026-10-07T23:50:00Z', session: { turns },
    summary: { sessionLatencyKneeContext: 40000, sessionAccuracyContext: 90000, verificationVerifiedContext: 32768,
      reliableOutputItems: 100, reliableOutputTokens: 4200, reliableToolTurns: 24, toolChecksCorrect: 12, toolChecksTotal: 12, ...summary } });
  const build = workload => buildLaneCapability({ model: MODEL, hostUrl: HOST, artifact: ARTIFACT,
    contextProfile: contextProfile(), now: NOW,
    performanceProfile: performanceProfile({ agentWorkload: workload }, { artifact: { digest: 'sha256:aaa', runtimeFingerprint: 'rt-1' } }) });

  it('recommends the smallest measured step and marks a capable model ready', () => {
    const capability = build(agentWorkload({}, [{ status: 'pass', contextTokens: 3000, latencyMs: 9000, correct: true }]));
    expect(capability.agent).toMatchObject({ status: 'measured', recommendedStepContext: 32768, reliableToolTurns: 24 });
    expect(capability.agent.sessionCurve).toEqual([{ contextTokens: 3000, latencyMs: 9000, correct: true }]);
    expect(capability.readiness.codingAgent).toBe('ready');
    expect(codes(capability)).not.toContain('agent_workload_missing');
  });

  it('marks a measured but weak model limited and says why', () => {
    const capability = build(agentWorkload({ sessionLatencyKneeContext: 6000, reliableToolTurns: 3, reliableOutputTokens: 900 }));
    expect(capability.readiness.codingAgent).toBe('limited');
    expect(codes(capability)).toEqual(expect.arrayContaining(['agent_session_short', 'agent_tools_unreliable', 'agent_output_short']));
  });

  it('does not call a model ready when its tool verdicts are mostly wrong', () => {
    const capability = build(agentWorkload({ toolChecksCorrect: 5 }));
    expect(capability.readiness.codingAgent).toBe('limited');
    expect(codes(capability)).toContain('agent_tool_answers_wrong');
  });

  it('ignores agent evidence from another runtime', () => {
    const capability = buildLaneCapability({ model: MODEL, hostUrl: HOST, artifact: ARTIFACT, contextProfile: contextProfile(), now: NOW,
      performanceProfile: performanceProfile({ agentWorkload: agentWorkload() }, { artifact: { digest: 'sha256:aaa', runtimeFingerprint: 'rt-old' } }) });
    expect(capability.agent.status).toBe('not_measured');
    expect(codes(capability)).toContain('performance_artifact_mismatch');
  });
});

describe('lane night campaign', () => {
  it('requests a Full profile for each lane still missing quality or agent evidence', async () => {
    const OTHER = 'http://gpu-a:11434';
    const submit = jest.fn(async request => ({ id: request.key, state: 'requested', revision: 1 }));
    const verified = { ...contextProfile(), qualityContextStatus: 'verified', qualityVerifiedContext: 131072 };
    const result = await requestLaneCampaign({ notBefore: '2026-10-17T03:00:00Z', startBefore: '2026-10-17T10:00:00Z' }, {
      hosts: () => [{ id: 'alien', url: HOST }, { id: 'frank', url: OTHER }],
      scope: async () => [{ hostUrl: HOST, hostName: 'UG Alien', model: MODEL, tasks: [] }, { hostUrl: OTHER, hostName: 'UG Frank', model: 'chat:12b', tasks: [] }],
      identity: async () => ARTIFACT,
      contextProfile: async (model) => (model === 'chat:12b' ? verified : contextProfile()),
      performanceProfile: async () => null,
      submit,
      reserve: async () => { throw new Error('not called without a fitting slot'); },
      queue: async () => ({ jobs: [] }),
      now: () => NOW
    });
    expect(result.requested).toBe(2);
    expect(submit.mock.calls.map(([request]) => request.executor)).toEqual([
      { hostId: 'alien', depth: 'full', skipRecentDays: 0, modelNames: [MODEL] }, { hostId: 'frank', depth: 'full', skipRecentDays: 0, modelNames: ['chat:12b'] }]);
    expect(submit.mock.calls[0][0].estimatedMinutes).toBe(180);
  });

  it('refuses an invalid window before recording anything', async () => {
    const submit = jest.fn();
    await expect(requestLaneCampaign({ notBefore: 'soon', startBefore: '2026-10-17T10:00:00Z' }, {
      hosts: () => [{ id: 'alien', url: HOST }], scope: async () => [{ hostUrl: HOST, hostName: 'UG Alien', model: MODEL, tasks: [] }],
      identity: async () => ARTIFACT, contextProfile: async () => contextProfile(), performanceProfile: async () => null, submit,
      queue: async () => ({ jobs: [] }), now: () => NOW
    })).rejects.toThrow('valid time');
    expect(submit).not.toHaveBeenCalled();
  });
});

describe('lane campaign slots', () => {
  const ALIEN_GPU = 'http://gpu-b:11434';
  const ALIEN_CPU = 'http://gpu-b:11435';
  const FRANK = 'http://gpu-a:11434';
  const night = { notBefore: '2026-10-17T03:00:00Z', startBefore: '2026-10-17T10:00:00Z' };
  const deps = (queueJobs = [], over = {}) => {
    const created = [];
    return {
      created,
      hosts: () => [{ id: 'alien', url: ALIEN_GPU }, { id: 'alien-cpu', url: ALIEN_CPU }, { id: 'frank', url: FRANK }],
      scope: async () => [
        { hostUrl: ALIEN_GPU, hostName: 'UG Alien', model: MODEL, tasks: [] },
        { hostUrl: ALIEN_CPU, hostName: 'UG Alien CPU', model: 'small:4b', tasks: [] },
        { hostUrl: FRANK, hostName: 'UG Frank', model: 'chat:12b', tasks: [] }],
      identity: async () => ARTIFACT, contextProfile: async () => contextProfile(), performanceProfile: async () => null,
      queue: async () => ({ jobs: [...queueJobs, ...created] }),
      submit: jest.fn(async request => { const job = { id: `id-${created.length}`, key: request.key, state: 'requested', revision: 1, hosts: request.hosts,
        title: request.title, source: request.source, executor: request.executor, updatedAt: '2026-10-16T12:00:00Z' }; created.push(job); return job; }),
      reserve: jest.fn(async (id, body) => { const job = created.find(item => item.id === id);
        Object.assign(job, { state: 'reserved', revision: 2, reservation: { start: body.start, end: new Date(Date.parse(body.start) + 180 * 60000).toISOString(), autoStart: body.autoStart } });
        return job; }),
      now: () => NOW,
      ...over
    };
  };

  it('runs one lane at a time per machine, machines in parallel, and says whether the night is long enough', async () => {
    const d = deps();
    const plan = await previewLaneCampaign(night, d);
    expect(plan.slots.map(slot => [slot.hostId, slot.start, slot.fits])).toEqual([
      ['alien', '2026-10-17T03:00:00.000Z', true], ['alien-cpu', '2026-10-17T06:00:00.000Z', true], ['frank', '2026-10-17T03:00:00.000Z', true]]);
    expect(plan.machines).toEqual(expect.arrayContaining([expect.objectContaining({ machine: 'gpu-b', lanes: 2, minutes: 360, fits: true })]));
    expect(plan.fits).toBe(true);
    expect(d.submit).not.toHaveBeenCalled();
    const short = await previewLaneCampaign({ notBefore: night.notBefore, startBefore: '2026-10-17T08:00:00Z' }, deps());
    expect(short.fits).toBe(false);
    expect(short.slots.filter(slot => !slot.fits).map(slot => slot.hostId)).toEqual(['alien-cpu']);
  });

  it('places lanes after work already planned on that machine', async () => {
    const busy = { id: 'other', state: 'reserved', hosts: [ALIEN_GPU], title: 'Image batch',
      reservation: { start: '2026-10-17T03:00:00.000Z', end: '2026-10-17T04:00:00.000Z' } };
    const plan = await previewLaneCampaign(night, deps([busy]));
    expect(plan.slots.find(slot => slot.hostId === 'alien').start).toBe('2026-10-17T04:00:00.000Z');
    expect(plan.slots.find(slot => slot.hostId === 'alien-cpu').start).toBe('2026-10-17T07:00:00.000Z');
    expect(plan.slots.find(slot => slot.hostId === 'alien-cpu').fits).toBe(true);
  });

  it('records, plans and opts in to the automatic start only when the owner asks', async () => {
    const d = deps();
    const result = await requestLaneCampaign({ ...night, autoStart: true }, d);
    expect(result).toMatchObject({ requested: 3, planned: 3, autoStart: true, fits: true });
    expect(d.reserve.mock.calls.map(([, body]) => body.autoStart)).toEqual([true, true, true]);
    const lanes = await listLaneCapabilities(d);
    expect(lanes.lanes.find(lane => lane.capability.hostId === 'alien-cpu').measurement)
      .toMatchObject({ state: 'reserved', start: '2026-10-17T06:00:00.000Z', autoStart: true });
    const manual = deps();
    await requestLaneCampaign(night, manual);
    expect(manual.reserve.mock.calls.every(([, body]) => body.autoStart === false)).toBe(true);
  });

  it('leaves a lane recorded but unplanned when it does not fit or Core refuses the slot', async () => {
    const d = deps([], { reserve: jest.fn(async () => { throw Object.assign(new Error('Core API 409'), {
      status: 409, body: JSON.stringify({ ok: false, message: 'Heavy-work reservation overlaps another request' }) }); }) });
    const result = await requestLaneCampaign({ notBefore: night.notBefore, startBefore: '2026-10-17T08:00:00Z', autoStart: true }, d);
    const cpu = result.results.find(row => row.hostId === 'alien-cpu');
    expect(cpu).toMatchObject({ planned: false, fits: false });
    expect(cpu.note).toMatch(/Does not fit/);
    expect(result.results.find(row => row.hostId === 'alien').note).toBe('Recorded but not planned: Heavy-work reservation overlaps another request');
    expect(d.reserve).toHaveBeenCalledTimes(2);
  });

  it('shows no measurement and plans from the window start when the queue cannot be read', async () => {
    const d = deps([], { queue: async () => { throw new Error('Core down'); } });
    const lanes = await listLaneCapabilities(d);
    expect(lanes.queueRead).toBe(false);
    expect(lanes.lanes.every(lane => lane.measurement === null)).toBe(true);
    expect((await previewLaneCampaign(night, d)).queueRead).toBe(false);
  });
});

describe('re-measurement proposals and concurrency', () => {
  const full = (over = {}, artifact = { digest: 'sha256:aaa', runtimeFingerprint: 'rt-1' }) => performanceProfile({ profileDepth: 'full',
    agentWorkload: { summary: { reliableToolTurns: 10 }, session: { turns: [] } },
    concurrency: { status: 'measured', worstSelfSlowdownPct: 38.5, worstOtherSlowdownPct: 20,
      pairs: [{ model: 'chat:12b', status: 'measured', selfSlowdownPct: 38.5, otherSlowdownPct: 20 }] }, ...over }, { artifact });
  const reasons = capability => capability.remeasure.reasons.map(reason => reason.code);

  it('proposes nothing for a lane with a current Full profile of its installed model and runtime', () => {
    const capability = buildLaneCapability({ model: MODEL, hostUrl: HOST, artifact: ARTIFACT, contextProfile: contextProfile(),
      performanceProfile: full(), now: NOW });
    expect(capability.remeasure).toEqual({ needed: false, depth: 'full', reasons: [] });
    expect(capability.concurrency).toMatchObject({ status: 'measured', worstSelfSlowdownPct: 38.5, separateEndpoints: 'not_measured' });
    expect(codes(capability)).not.toContain('concurrency_unmeasured');
  });

  it('names a changed model, a changed runtime, an old profile and a missing Full profile', () => {
    const changedModel = buildLaneCapability({ model: MODEL, hostUrl: HOST, artifact: ARTIFACT, contextProfile: null,
      performanceProfile: full({}, { digest: 'sha256:old', runtimeFingerprint: 'rt-1' }), now: NOW });
    expect(reasons(changedModel)).toEqual(['model_changed', 'full_missing']);
    const changedRuntime = buildLaneCapability({ model: MODEL, hostUrl: HOST, artifact: ARTIFACT, contextProfile: contextProfile(),
      performanceProfile: full({}, { digest: 'sha256:aaa', runtimeFingerprint: 'rt-0' }), now: NOW });
    expect(reasons(changedRuntime)).toEqual(['runtime_changed', 'full_missing']);
    expect(changedRuntime.remeasure.reasons[0].text).toMatch(/Ollama, its settings or the host hardware/);
    const old = buildLaneCapability({ model: MODEL, hostUrl: HOST, artifact: ARTIFACT,
      contextProfile: contextProfile({ lastValidatedAt: '2026-08-01T00:00:00Z' }),
      performanceProfile: full({ profiledAt: '2026-08-01T00:00:00Z' }), now: NOW });
    expect(reasons(old)).toEqual(['profile_old']);
    const standard = buildLaneCapability({ model: MODEL, hostUrl: HOST, artifact: ARTIFACT, contextProfile: contextProfile(),
      performanceProfile: performanceProfile(), now: NOW });
    expect(reasons(standard)).toEqual(['full_missing']);
    expect(codes(standard)).toContain('concurrency_unmeasured');
    const never = buildLaneCapability({ model: MODEL, hostUrl: HOST, artifact: ARTIFACT, now: NOW });
    expect(reasons(never)).toEqual(['never_measured']);
  });

  it('does not propose a lane whose identity is unknown, and reports eviction', () => {
    const unknown = buildLaneCapability({ model: MODEL, hostUrl: HOST, artifact: null, now: NOW });
    expect(unknown.remeasure.needed).toBe(false);
    expect(unknown.remeasure.blocked).toMatch(/could not be identified/);
    const evicted = buildLaneCapability({ model: MODEL, hostUrl: HOST, artifact: ARTIFACT, contextProfile: contextProfile(),
      performanceProfile: full({ concurrency: { status: 'evicted', pairs: [{ model: 'chat:12b', status: 'evicted' }] } }), now: NOW });
    expect(codes(evicted)).toContain('concurrency_evicts');
  });
});
