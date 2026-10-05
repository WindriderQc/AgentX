'use strict';

const fs = require('node:fs');
const path = require('node:path');

function publicSource(file) {
  return fs.readFileSync(path.resolve(__dirname, '..', '..', '..', 'public', 'js', 'model-profiler', file), 'utf8');
}

describe('profiler UI evidence semantics', () => {
  test('renders capacity and workload recommendations as distinct fields', () => {
    const render = publicSource('models-render.js');
    expect(render).toContain('p.maxVerifiedContext');
    expect(render).toContain('p.recommendedInteractiveContext');
    expect(render).toContain('p.recommendedDocumentContext');
    expect(render).toContain('p.performanceKneeContext');
    expect(render).toContain('p.qualityVerifiedContext');
    expect(render).toContain('max verified');
    expect(render).toContain('performance knee');
    expect(render).toContain('quality-verified context');
    expect(render).not.toContain('p.optimalNumCtx');
    expect(render).not.toContain('p.recommendedContext');
    expect(render).not.toMatch(/optimal ctx/i);
  });

  test('labels missing concurrency and lab telemetry as unknown, never production-best evidence', () => {
    const render = publicSource('models-render.js');
    const profiling = publicSource('models-profiling.js');
    expect(render).toContain('agentx.profiler-hardware-collector/v1');
    expect(render).toContain('lab GPU telemetry unknown');
    expect(profiling).toContain('quality-verified context');
    expect(profiling).not.toMatch(/best production/i);
  });

  test('keeps the Full prefill/decode matrix visible and unknown offload explicit', () => {
    const profiling = publicSource('models-profiling.js');
    expect(profiling).toContain('Prefill / Decode Matrix');
    expect(profiling).toContain('profile?.prefillDecodeMatrix');
    expect(profiling).toContain("? 'Unknown'");
    expect(profiling).toContain('95% CI');
    expect(profiling).toContain('coefficientOfVariation');
    expect(profiling).not.toMatch(/optimal ctx/i);
  });

  test('shows agent-sized prefill and long-context quality, in the backend step order (#367)', () => {
    const profiling = publicSource('models-profiling.js');
    expect(profiling).toContain('profile?.prefillDecodeMatrix?.longPrefill');
    expect(profiling).toContain('profile?.longContextQuality');
    expect(profiling).toContain('Agent-sized prefill');
    const pipeline = fs.readFileSync(path.resolve(__dirname, '..', '..', '..', 'routes', 'profiler', 'pipeline.js'), 'utf8');
    const backendFull = pipeline.match(/full:\s*\[([^\]]+)\]/)[1].split(',').map(step => step.trim().replace(/'/g, ''));
    const frontendFull = profiling.match(/full:\s*\[([^\]]+)\]/)[1].split(',').map(step => step.trim().replace(/'/g, ''));
    expect(frontendFull).toHaveLength(backendFull.length);
    expect(backendFull.indexOf('long_context_quality')).toBe(frontendFull.indexOf('Long-context quality'));
    expect(backendFull.indexOf('long_context_quality')).toBe(backendFull.indexOf('prefill_decode_matrix') + 1);
  });

  test('renders only aggregate streamed TTFT p50 instead of a representative throughput sample', () => {
    const render = publicSource('models-render.js');
    const profiling = publicSource('models-profiling.js');
    expect(render).toContain('p.ttftP50Ms');
    expect(render).toContain("p.ttftMeasurement === 'streamed_wall_clock'");
    expect(profiling).toContain('measurementQuality?.ttftP50Ms');
    expect(profiling).toContain('TTFT p50');
    expect(render).not.toContain('p.ttftMs');
  });

  test('renders an unqualified Full run as incomplete instead of successful', () => {
    const profiling = publicSource('models-profiling.js');
    expect(profiling).toContain("const unqualifiedFull = depth === 'full' && !benchmarkQualified");
    expect(profiling).toContain('Full profile incomplete — not qualified on');
    expect(profiling).toContain("unqualifiedFull ? 'Not qualified' : 'Profiled ✓'");
  });

  test('rebuilds persistent authority badges and masks non-authoritative recommendations on reload', () => {
    const models = publicSource('models.js');
    const helpers = publicSource('models-helpers.js');
    const render = publicSource('models-render.js');
    expect(models).toContain('classifyProfileEvidence(profile, evidence, selectedHostId)');
    expect(models).toContain('evidenceProfile.recommendedInteractiveContext = null');
    expect(models).toContain('evidenceProfile.recommendedDocumentContext = null');
    expect(helpers).toContain("status: stale ? 'stale' : qualified ? 'qualified'");
    expect(render).toContain("{ label: 'Qualified', tone: 'qualified' }");
    expect(render).toContain("{ label: 'Not qualified', tone: 'unqualified' }");
    expect(render).toContain("{ label: 'Stale', tone: 'stale' }");
    expect(render).toContain('recommendationsAuthoritative === true');
  });
});
