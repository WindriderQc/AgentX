'use strict';

const fs = require('node:fs');
const path = require('node:path');
const attention = require('../../public/js/pipeline-attention');
const { readPipelineSource, loadPipelineParts } = require('../helpers/pipelineScripts');

const script = readPipelineSource();
const view = fs.readFileSync(path.resolve(__dirname, '../../views/pages/pipeline.ejs'), 'utf8');

function payload({ total = 25, offset = 0, complete = true, keys } = {}) {
  const all = keys || Array.from({ length: total }, (_, index) => `${String(index + 1).padStart(4, '0')}:human_review`);
  const items = all.slice(offset, offset + attention.WINDOW_SIZE).map(key => ({ key, pipelineId: key.split(':')[0], rank: 1 }));
  return { schema: 'agentx.pipeline-attention/v1', authority: 'core.pipeline', items,
    page: { offset, limit: attention.WINDOW_SIZE, returnedCount: items.length },
    coverage: complete ? { complete, total: all.length, lowerBound: all.length } : { complete, total: null, lowerBound: all.length, scannedCount: 40, candidateCount: 90, order: 'pipelineId ascending' },
    signal: { fingerprint: all.join('|'), keys: all }, otherScope: { scope: 'private', count: null } };
}

describe('Pipeline attention queue', () => {
  test('no longer truncates attention to ten items in the board script', () => {
    expect(script).not.toMatch(/slice\(0, 10\)/);
    expect(script).toContain("readProjection('attention', url)");
    for (const id of ['pipelineAttentionPager', 'pipelineAttentionScopes', 'pipelineAttentionNotes', 'pipelineAttentionLive']) {
      expect(view).toContain(`id="${id}"`);
    }
  });

  test('distinguishes known total, loaded window and displayed page for 25 items', () => {
    const view25 = payload();
    expect(attention.describe(view25, 0)).toBe('25 items need action (exact) · 25 loaded (1–25) · showing 1–10');
    expect(attention.describe(view25, 2)).toBe('25 items need action (exact) · 25 loaded (1–25) · showing 21–25');
    expect(attention.lastPageIndex(view25)).toBe(2);
    const pages = [0, 1, 2].flatMap(index => attention.pageItems(view25, index).map(item => item.pipelineId));
    expect(new Set(pages).size).toBe(25);
  });

  test('reads a new window when paging beyond the loaded rows', () => {
    expect(attention.windowOffset(4)).toBe(0);
    expect(attention.windowOffset(5)).toBe(50);
    const second = payload({ total: 120, offset: 50 });
    expect(attention.describe(second, 6)).toBe('120 items need action (exact) · 50 loaded (51–100) · showing 61–70');
  });

  test('labels partial coverage as a lower bound, never an exact total', () => {
    const partial = payload({ total: 40, complete: false });
    expect(attention.describe(partial, 0)).toMatch(/^At least 40 need action · total unknown/);
  });

  test('the Pipeline banner distinguishes exact, partial and unavailable engineering counts', () => {
    expect(attention.bannerState({ complete: true, total: 25 }).title).toBe('25 engineering tasks need action');
    expect(attention.bannerState({ complete: true, total: 0 }).title).toBe('Engineering queue clear');
    const partial = attention.bannerState({ complete: false, total: null, lowerBound: 40 });
    expect(partial.title).toBe('Engineering attention total unknown');
    expect(partial.detail).toContain('At least 40');
    expect(attention.bannerState(null).title).toBe('Engineering attention unknown');
    for (const malformed of [{ complete: true, total: null }, { complete: true, total: '0' },
      { complete: false, total: null, lowerBound: undefined }]) {
      expect(attention.bannerState(malformed).title).toBe('Engineering attention unknown');
    }
    expect(script).toContain('bannerState?.(state.attention?.engineeringCoverage())');
    expect(script).toContain('onChange: summarizeState');
  });

  test('a refreshed engineering observation updates the banner, while private or failed reads provide no engineering total', async () => {
    const onChange = jest.fn();
    const controller = new attention.Controller({ elements: {}, filters: {}, onChange,
      fetchJson: async () => ({ data: { attention: { ...payload(), scope: 'engineering' } } }) });
    await controller.refresh();
    expect(controller.engineeringCoverage().total).toBe(25);
    expect(onChange).toHaveBeenCalled();
    controller.scope = 'private';
    expect(controller.engineeringCoverage()).toBeNull();
    controller.scope = 'engineering';
    controller.error = new Error('read failed');
    expect(controller.engineeringCoverage()).toBeNull();
  });

  test('signals only newly observed actionable keys for the same basis', () => {
    const base = { basis: 'engineering|{}', fingerprint: 'a', keys: ['0001:human_review', '0002:inspect_blocker'] };
    expect(attention.diffSignal(null, base)).toEqual({ changed: true, newKeys: [], announce: false });
    expect(attention.diffSignal(base, { ...base })).toEqual({ changed: false, newKeys: [], announce: false });
    expect(attention.diffSignal(base, { ...base, fingerprint: 'b', keys: ['0001:human_review'] }))
      .toEqual({ changed: true, newKeys: [], announce: false });
    expect(attention.diffSignal(base, { ...base, fingerprint: 'c', keys: [...base.keys, '0003:inspect_worker'] }))
      .toEqual({ changed: true, newKeys: ['0003:inspect_worker'], announce: true });
    expect(attention.diffSignal(base, { ...base, basis: 'private|{}', fingerprint: 'd' }).announce).toBe(false);
  });

  test('maps board filters and Agent Ops focus into one query', () => {
    expect(attention.buildQuery({ filters: { status: null, search: 'x', service: 'core', lane: '', epic: '' } }))
      .toEqual({ search: 'x', service: 'core' });
    expect(attention.buildQuery({ filters: { status: 'review' }, context: { task: '0001', assignee: 'a', status: 'review' } }))
      .toEqual({ status: 'review', task: '0001', assignee: 'a' });
    expect(attention.buildQuery({ filters: { status: 'blocked' }, context: { status: 'review' } })).toBeNull();
  });

  test('shows the other queue count only from an observation already made', () => {
    const view25 = payload();
    expect(attention.scopeNote(view25, undefined)).toBe('Private and household lanes are a separate queue, not counted here.');
    expect(attention.scopeNote(view25, { count: 3, complete: true })).toBe('3 private or household lane items at last view stay in their own queue.');
    expect(attention.scopeNote(view25, { count: 0, complete: true })).toBe('');
    expect(attention.scopeNote({ ...view25, otherScope: { scope: 'engineering', count: null } }, undefined)).toBe('');
  });

  test('rejects unknown payload shapes instead of rendering them as empty', () => {
    expect(attention.validPayload(payload())).toBe(true);
    expect(attention.validPayload({ ...payload(), schema: 'other' })).toBe(false);
    expect(attention.validPayload({ ...payload(), signal: null })).toBe(false);
    expect(attention.validPayload({ ...payload(), coverage: { complete: true, total: null } })).toBe(false);
  });
});
