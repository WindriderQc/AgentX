'use strict';

const { loadBrowserModule } = require('../../helpers/browserModule');
const { buildLaneCapability } = require('../../../src/services/profiler/laneCapability');

const helpers = {
  _fmtCtx: n => (n >= 1024 ? `${Math.round(n / 1024)}k` : String(n)),
  escAttr: value => String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
};
const ui = loadBrowserModule('model-profiler/components/lane-capability.js',
  'renderLaneCard, renderLaneSummary, renderContextGauge, laneWarnings, buildMeasureRequest, taskLabel, ageText, renderSessionCurve, campaignTargets, campaignText, renderMeasurement, measurementOpen, renderCampaignPlan, campaignResultText, clock', helpers);

const NOW = new Date('2026-10-16T12:00:00Z');
const capability = (over = {}) => buildLaneCapability({
  model: 'coder:27b-q8_0', hostUrl: 'http://gpu-b:11434', hostId: 'alien',
  artifact: { digest: 'sha256:aaa', runtimeFingerprint: 'rt' },
  contextProfile: {
    maxVerifiedContext: 262144, recommendedInteractiveContext: 65536, recommendedDocumentContext: 131072,
    performanceKneeContext: 32768, recommendationStatus: 'verified', modelTheoreticalMax: 262144,
    lastValidatedAt: '2026-10-07T23:00:00Z', ...over
  },
  performanceProfile: { _id: 'p', artifact: { digest: 'sha256:aaa' },
    profile: { profileDepth: 'standard', tokensPerSec: 53.6, promptEvalTokensPerSec: 1450, ttftP50Ms: 820, comparisonNumCtx: 8192,
      profiledAt: '2026-10-07T23:02:00Z' } },
  now: NOW
});
const lane = (over = {}) => ({ hostName: 'UG Alien', residency: 'gpu', pinned: true, pinContext: 196608,
  tasks: ['code_generation', 'master_brain'], capability: capability(), ...over });

describe('lane capability card', () => {
  it('shows readiness, measured context, speed, provenance and the missing measurements', () => {
    const html = ui.renderLaneCard(lane(), 0);
    expect(html).toContain('coder:27b-q8_0');
    expect(html).toContain('UG Alien');
    expect(html).toContain('>Pinned<');
    expect(html).toContain('>Coding<');
    expect(html).toContain('>Master brain<');
    expect(html).toMatch(/Chat<\/span><span class="lc-ready-state">Ready/);
    expect(html).toMatch(/Documents<\/span><span class="lc-ready-state">Speed only/);
    expect(html).toMatch(/Coding agent<\/span><span class="lc-ready-state">Not measured/);
    expect(html).toContain('lc-swatch--knee" aria-hidden="true"></i>Speed knee (≤15% slower)</span><strong>32k</strong>');
    expect(html).toContain('lc-swatch--pin" aria-hidden="true"></i>Runtime window</span><strong>192k</strong>');
    expect(html).toContain('Quality verified</span><strong>unknown</strong>');
    expect(html).toContain('53.6 tok/s');
    expect(html).toContain('1450 tok/s');
    expect(html).toContain('measured 8 days ago · standard profile');
    expect(html).toContain('4 missing measurements');
    expect(html).toContain('Not measured yet. A Full profile measures a growing session');
    expect(html).toContain('Agent workload (growing session');
    expect(html).toContain('data-lane-action="measure"');
  });

  it('warns when the runtime window is past the speed knee', () => {
    expect(ui.laneWarnings(lane())[0]).toContain('The runtime window (192k) is past the speed knee (32k)');
    expect(ui.laneWarnings(lane({ pinContext: 16384 }))).toEqual([]);
    expect(ui.renderLaneCard(lane())).toContain('size work steps below the knee');
  });

  it('draws no gauge markers it has no measurement for', () => {
    const empty = buildLaneCapability({ model: 'x', hostUrl: 'http://h:1', now: NOW });
    expect(ui.renderContextGauge(empty, null)).toContain('No context measurement');
    const html = ui.renderContextGauge(capability({ performanceKneeContext: null }), null);
    expect(html).not.toContain('lc-gauge-mark--knee');
    expect(html).not.toContain('lc-gauge-pin');
  });

  it('escapes model and host names', () => {
    const html = ui.renderLaneCard(lane({ hostName: '<b>host</b>', capability: { ...capability(), model: 'a"<script>' } }));
    expect(html).not.toContain('<script>');
    expect(html).not.toContain('<b>host</b>');
  });

  it('disables measurement when the lane host is not configured in the Profiler', () => {
    const html = ui.renderLaneCard(lane({ capability: { ...capability(), hostId: null } }));
    expect(html).toMatch(/data-lane-action="measure"[^>]*disabled/);
    expect(html).toContain('This host is not configured in the Profiler');
  });

  it('summarizes the lanes by what needs attention', () => {
    const html = ui.renderLaneSummary([lane(), lane({ pinContext: 8192 })]);
    expect(html).toContain('<strong>2</strong> lanes');
    expect(html).toContain('<strong>1</strong> past the speed knee');
    expect(html).toContain('<strong>2</strong> without verified quality');
    expect(html).toContain('<strong>0</strong> ready for coding agents');
  });
});

describe('measure tonight window', () => {
  it('asks for tonight 23:00 to 06:00 in local time for exactly this lane', () => {
    const request = ui.buildMeasureRequest(lane(), new Date(2026, 9, 16, 14, 30));
    expect(request).toEqual({
      model: 'coder:27b-q8_0',
      hostUrl: 'http://gpu-b:11434',
      notBefore: new Date(2026, 9, 16, 23, 0).toISOString(),
      startBefore: new Date(2026, 9, 17, 6, 0).toISOString()
    });
  });

  it('moves to the next night after 23:00 and refuses an unconfigured host', () => {
    const late = ui.buildMeasureRequest(lane(), new Date(2026, 9, 16, 23, 30));
    expect(late.notBefore).toBe(new Date(2026, 9, 17, 23, 0).toISOString());
    expect(() => ui.buildMeasureRequest(lane({ capability: { ...capability(), hostId: null } }))).toThrow('no configured Profiler host');
  });

  it('labels tasks and ages in plain words', () => {
    expect(ui.taskLabel('daily_operator')).toBe('Daily assistant');
    expect(ui.taskLabel('rag_rerank')).toBe('rag rerank');
    expect(ui.ageText(null)).toBe('never measured');
    expect(ui.ageText(0)).toBe('measured today');
    expect(ui.ageText(12)).toBe('measured 12 days ago');
  });
});

describe('agent work on the lane card', () => {
  const measured = () => {
    const base = capability();
    return { ...base, readiness: { ...base.readiness, codingAgent: 'limited' }, agent: {
      status: 'measured', recommendedStepContext: 24576, reliableToolTurns: 6, toolChecksCorrect: 5, toolChecksTotal: 12,
      reliableOutputTokens: 4200, verificationVerifiedContext: 32768,
      sessionCurve: [{ contextTokens: 3000, latencyMs: 9000, correct: true }, { contextTokens: 30000, latencyMs: 60000, correct: false }] } };
  };

  it('shows the recommended step, tool reliability, output and the session curve', () => {
    const html = ui.renderLaneCard(lane({ capability: measured() }));
    expect(html).toMatch(/Coding agent<\/span><span class="lc-ready-state">Limited/);
    expect(html).toContain('<dt>Recommended step</dt><dd>24k</dd>');
    expect(html).toContain('6 turns · 5/12 right');
    expect(html).toContain('<dt>Finds mismatches up to</dt><dd>32k</dd>');
    expect(html).toContain('red dots are wrong answers');
    expect(html).toContain('lc-dot lc-dot--wrong');
  });

  it('draws no curve from fewer than two turns', () => {
    expect(ui.renderSessionCurve([{ contextTokens: 3000, latencyMs: 9000, correct: true }])).toBe('');
    expect(ui.renderSessionCurve(null)).toBe('');
  });

  it('targets only lanes with a re-measurement proposal and explains the cost', () => {
    const done = lane({ capability: { ...measured(), remeasure: { needed: false, reasons: [] } } });
    const targets = ui.campaignTargets([lane(), done, lane({ capability: { ...capability(), hostId: null } })]);
    expect(targets).toHaveLength(1);
    expect(ui.campaignText(targets)).toContain('Measure 1 lane tonight, 23:00 to 06:00, on 1 host');
    expect(ui.campaignText(targets)).toContain('about three hours');
    expect(ui.campaignText([])).toMatch(/^No lane needs re-measurement/);
  });
});

describe('proposals and concurrency on the lane card', () => {
  it('shows why a lane should be measured again', () => {
    const html = ui.renderLaneCard(lane());
    expect(html).toContain('Re-measurement proposed');
    expect(html).toContain('No Full profile exists yet');
    expect(html).toContain('Not measured yet (Full profile).');
    expect(ui.renderLaneSummary([lane()])).toContain('<strong>1</strong> re-measurement proposed');
  });

  it('shows the slowdown beside each co-resident and an eviction plainly', () => {
    const measured = { ...capability(), remeasure: { needed: false, reasons: [] }, concurrency: { status: 'measured',
      pairs: [{ model: 'chat:12b', status: 'measured', selfSlowdownPct: 38.5, otherSlowdownPct: 20 }] } };
    const html = ui.renderLaneCard(lane({ capability: measured }));
    expect(html).not.toContain('Re-measurement proposed');
    expect(html).toContain('with chat:12b</span><strong>39 % slower</strong>');
    expect(html).toContain('it slows 20 %');
    const evicted = ui.renderLaneCard(lane({ capability: { ...measured, concurrency: { status: 'evicted', pairs: [] } } }));
    expect(evicted).toContain('one evicts the other');
  });

  it('labels a pair on the other endpoint and says when other endpoints were not covered', () => {
    const concurrency = { status: 'measured', separateEndpoints: 'measured',
      pairs: [{ model: 'gemma:26b', endpoint: 'sibling', status: 'measured', selfSlowdownPct: 3.6, otherSlowdownPct: 9 }] };
    const html = ui.renderLaneCard(lane({ capability: { ...capability(), remeasure: { needed: false, reasons: [] }, concurrency } }));
    expect(html).toContain('with gemma:26b (other endpoint, same machine)</span><strong>4 % slower</strong>');
    expect(html).not.toContain('Other endpoints of this machine');
    const uncovered = ui.renderLaneCard(lane({ capability: { ...capability(), remeasure: { needed: false, reasons: [] },
      concurrency: { ...concurrency, separateEndpoints: 'not_measured', pairs: [] } } }));
    expect(uncovered).toContain('Other endpoints of this machine: not measured');
  });
});

describe('measurement state and the night plan', () => {
  const local = (h, m = 0) => new Date(2026, 9, 17, h, m).toISOString();

  it('says on the card when a planned measurement starts by itself, and hides the button meanwhile', () => {
    const planned = { id: 'q1', state: 'reserved', start: local(23), end: local(2), autoStart: true };
    const html = ui.renderLaneCard(lane({ measurement: planned }));
    expect(html).toContain('Planned 23:00–02:00; starts automatically.');
    expect(html).toContain('href="/automations?view=calendar"');
    expect(html).not.toContain('data-lane-action="measure"');
    expect(ui.renderLaneCard(lane({ measurement: { ...planned, state: 'completed', finishedAt: local(2) } }))).toContain('data-lane-action="measure"');
    expect(ui.renderLaneCard(lane())).toContain('data-lane-action="measure"');
  });

  it.each([
    [{ state: 'requested' }, 'no slot yet', 'wait'],
    [{ state: 'reserved', start: local(23), end: local(2), autoStart: false }, 'start it yourself then', 'wait'],
    [{ state: 'running', end: local(2) }, 'Measuring now, about until 02:00', 'running'],
    [{ state: 'uncertain' }, 'will not be retried', 'bad'],
    [{ state: 'failed' }, 'failed', 'bad']
  ])('describes %o', (m, text, tone) => {
    const html = ui.renderMeasurement(m);
    expect(html).toContain(text);
    expect(html).toContain(`lc-measurement--${tone}`);
  });

  it('shows no line without a request and treats only waiting or active ones as open', () => {
    expect(ui.renderMeasurement(null)).toBe('');
    expect(ui.measurementOpen({ state: 'reserved' })).toBe(true);
    expect(ui.measurementOpen({ state: 'completed' })).toBe(false);
  });

  it('lays out the night per machine and flags lanes that would end after the window', () => {
    const plan = { windowEnd: local(6), machines: [{ machine: 'gpu-b' }, { machine: 'gpu-a' }], slots: [
      { model: 'coder:27b', hostId: 'alien', hostName: 'UG Alien', machine: 'gpu-b', start: local(23), end: local(2), fits: true },
      { model: 'small:4b', hostId: 'alien-cpu', hostName: 'UG Alien CPU', machine: 'gpu-b', start: local(2), end: local(5), fits: true },
      { model: 'chat:12b', hostId: 'frank', hostName: 'UG Frank', machine: 'gpu-a', start: local(23), end: local(2), fits: true }] };
    const html = ui.renderCampaignPlan(plan);
    expect(html).toContain('3 lanes on 2 machines: one lane at a time per machine, machines in parallel. Done by about 05:00.');
    expect(html).toContain('02:00–05:00');
    const late = ui.renderCampaignPlan({ ...plan, slots: [...plan.slots, { model: 'big:70b', hostId: 'alien', machine: 'gpu-b', start: local(5), end: local(8), fits: false }] });
    expect(late).toContain('1 of 4 would end after 06:00');
    expect(late).toContain('Ends after 06:00');
    expect(ui.renderCampaignPlan({ slots: [] })).toBe('');
  });

  it('summarizes what was planned and who starts it', () => {
    expect(ui.campaignResultText({ autoStart: true, planned: 2, results: [{ planned: true }, { planned: true }, { planned: false }] }))
      .toBe('2 planned; Core starts each one at its time. 1 recorded without a slot.');
    expect(ui.campaignResultText({ autoStart: false, planned: 1, results: [{ planned: true }, { error: 'not recorded' }] }))
      .toBe('1 planned; start each from Automations → Calendar at its time. 1 not recorded.');
  });
});

describe('lane card Ollama version drift (#908)', () => {
  const driftUi = loadBrowserModule('model-profiler/components/lane-capability.js', 'renderRuntimeDrift, renderLaneCard', helpers);

  it('says which version measured the profile and that it is still used', () => {
    const html = driftUi.renderRuntimeDrift({ measured: '0.34.4', installed: '0.40.8' });
    expect(html).toContain('Measured on Ollama 0.34.4; 0.40.8 is installed now');
    expect(html).toContain('still used');
    expect(driftUi.renderRuntimeDrift({ measured: null, installed: '0.40.8' })).toContain('was not recorded');
    expect(driftUi.renderRuntimeDrift(null)).toBe('');
  });

  it('shows the warning on the card beside the Measure tonight action', () => {
    const cap = buildLaneCapability({
      model: 'coder:27b-q8_0', hostUrl: 'http://gpu-b:11434', hostId: 'alien',
      artifact: { digest: 'sha256:aaa', runtimeFingerprint: 'rt', runtime: { ollamaVersion: '0.40.8' } },
      contextProfile: { maxVerifiedContext: 65536, recommendationStatus: 'verified', recommendedInteractiveContext: 32768,
        recommendedDocumentContext: 65536, measuredRuntime: { ollamaVersion: '0.34.4' }, lastValidatedAt: '2026-10-07T23:00:00Z' },
      now: NOW
    });
    const html = driftUi.renderLaneCard({ hostName: 'UG Alien', capability: cap, tasks: [] });
    expect(html).toContain('lc-warning--runtime');
    expect(html).toContain('data-lane-action="measure"');
    expect(html).toContain('The installed Ollama version differs');
  });
});
