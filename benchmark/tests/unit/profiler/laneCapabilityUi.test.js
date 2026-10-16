'use strict';

const { loadBrowserModule } = require('../../helpers/browserModule');
const { buildLaneCapability } = require('../../../src/services/profiler/laneCapability');

const helpers = {
  _fmtCtx: n => (n >= 1024 ? `${Math.round(n / 1024)}k` : String(n)),
  escAttr: value => String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
};
const ui = loadBrowserModule('model-profiler/components/lane-capability.js',
  'renderLaneCard, renderLaneSummary, renderContextGauge, laneWarnings, buildMeasureRequest, taskLabel, ageText', helpers);

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
    expect(html).toContain('3 missing measurements');
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
