'use strict';

jest.mock('../../src/clients/coreModelHostApi', () => ({ getDedicationStatuses: jest.fn() }));
jest.mock('../../src/clients/coreCoverageReads', () => ({ getRoutingConfig: jest.fn() }));

const { resolveScope } = require('../../src/services/measurementCoverage/coverageScope');
const { computeCoverage, profileState } = require('../../src/services/measurementCoverage/coverageState');

const GPU = 'http://gpu-a:11434';
const CPU = 'http://cpu-a:11435';
const hosts = () => [
  { id: 'primary', name: 'GPU A', url: GPU, residency: 'gpu' },
  { id: 'cpu-a', name: 'CPU A', url: CPU, residency: 'cpu' }
];

describe('coverage scope', () => {
  it('takes the models pinned on a host and the models routed to it, once each', async () => {
    const scope = await resolveScope({
      hosts,
      preferences: async () => [
        { hostUrl: `${GPU}/`, pinnedModels: [{ model: 'big:27b' }, { model: 'bge-m3:latest' }] },
        { hostUrl: CPU, pinnedModels: ['small:26b'] },
        { hostUrl: 'http://unknown:11434', pinnedModels: [{ model: 'ghost:1b' }] }
      ],
      routing: async () => ({
        taskModels: {
          general_chat: { model: 'big:27b', host: 'primary' },
          ops_watch: { model: 'small:26b', host: 'cpu-a' },
          janitor_ai: { model: 'other:7b', host: 'cpu-a' },
          embeddings: { model: 'nomic-embed-text:v1.5', host: 'primary' },
          orphan: { model: 'big:27b', host: 'gone' }
        },
        hosts: { primary: { url: GPU }, 'cpu-a': CPU }
      })
    });
    expect(scope.map(cell => [cell.hostName, cell.model, cell.pinned, cell.tasks])).toEqual([
      ['CPU A', 'other:7b', false, ['janitor_ai']],
      ['CPU A', 'small:26b', true, ['ops_watch']],
      ['GPU A', 'big:27b', true, ['general_chat']]
    ]);
    expect(scope[0].residency).toBe('cpu');
  });
});

describe('coverage matrix', () => {
  const catalog = new Map([
    ['fp-1', { id: 'p1', name: 'One', category: 'agent', level: 1 }],
    ['fp-2', { id: 'p2', name: 'Two', category: 'agent', level: 2 }],
    ['fp-3', { id: 'p3', name: 'Three', category: 'coding', level: 1 }]
  ]);
  const scope = [
    { hostUrl: CPU, hostName: 'CPU A', residency: 'cpu', model: 'small:26b', pinned: true, tasks: ['ops_watch'] },
    { hostUrl: GPU, hostName: 'GPU A', residency: 'gpu', model: 'big:27b', pinned: true, tasks: [] }
  ];
  const hostIds = new Map([['http://cpu-a:11435', 'cpu-a'], ['http://gpu-a:11434', 'primary']]);
  const current = digest => ({ stage: 'profiled', profileDepth: 'standard', benchmarkQualified: true, artifact: { digest } });

  it('reads the profile state from the readiness entry', () => {
    expect(profileState(null).state).toBe('missing');
    expect(profileState({ stage: 'available' }).state).toBe('missing');
    expect(profileState({ ...current('a'), stale: true }).state).toBe('stale');
    expect(profileState({ ...current('a'), authorityState: 'authority_invalidated' }).state).toBe('stale');
    expect(profileState({ ...current('a'), profileDepth: 'quick' }).state).toBe('unqualified');
    expect(profileState({ ...current('a'), benchmarkQualified: false }).state).toBe('unqualified');
    expect(profileState(current('a'))).toMatchObject({ state: 'current', depth: 'standard', reason: null });
  });

  it('counts a prompt only when the profiled artifact has a scored answer for it', () => {
    const coverage = computeCoverage({
      scope, catalog, hostIds,
      readiness: new Map([['cpu-a::small:26b', current('sha256:AAA')]]),
      answers: new Map([
        ['http://cpu-a:11435::small:26b', new Map([['fp-1', ['aaa']], ['fp-2', ['old-digest']], ['fp-9', ['aaa']]])],
        ['http://gpu-a:11434::big:27b', new Map([['fp-1', ['zzz']], ['fp-2', ['zzz']], ['fp-3', []]])]
      ])
    });
    const [cpu, gpu] = coverage.cells;
    expect(cpu).toMatchObject({
      hostId: 'cpu-a', complete: false, next: 'benchmark', missingPromptIds: ['p2', 'p3'],
      profile: { state: 'current' },
      catalog: { total: 3, covered: 1, byCategory: { agent: { total: 2, covered: 1 }, coding: { total: 1, covered: 0 } } }
    });
    // No profile yet: every scored answer counts, and the profile comes first.
    expect(gpu).toMatchObject({ complete: false, next: 'profile', profile: { state: 'missing' }, catalog: { covered: 3 } });
    expect(coverage.summary).toEqual({ cells: 2, complete: 0, profilesCurrent: 1, prompts: 6, covered: 4, percent: 66.7 });
  });

  it('marks a pair complete once its profile is current and every prompt is scored', () => {
    const coverage = computeCoverage({
      scope: [scope[0]], catalog, hostIds,
      readiness: new Map([['cpu-a::small:26b', current('aaa')]]),
      answers: new Map([['http://cpu-a:11435::small:26b', new Map([['fp-1', ['aaa']], ['fp-2', ['aaa']], ['fp-3', ['aaa']]])]])
    });
    expect(coverage.cells[0]).toMatchObject({ complete: true, next: null, missingPromptIds: [] });
    expect(coverage.summary).toMatchObject({ complete: 1, percent: 100 });
    expect(computeCoverage({ scope: [], catalog, hostIds, readiness: new Map(), answers: new Map() }).summary.percent).toBe(0);
  });
});
