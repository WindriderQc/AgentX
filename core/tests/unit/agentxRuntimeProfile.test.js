const {
  normalizeAgentXProfile,
  demoSurfaceDisabled,
  createAgentXProfileGuard,
  DEMO_DISABLED_PREFIXES
} = require('../../../shared/agentxRuntimeProfile');

describe('Agent X runtime profile', () => {
  test('defaults safely to demo and requires an explicit full profile', () => {
    expect(normalizeAgentXProfile('demo')).toBe('demo');
    expect(normalizeAgentXProfile('DEMO')).toBe('demo');
    expect(normalizeAgentXProfile('')).toBe('demo');
    expect(normalizeAgentXProfile('personal')).toBe('demo');
    expect(normalizeAgentXProfile('full')).toBe('full');
  });

  test.each([
    '/api/agent-ops',
    '/api/openclaw-ollama/api/chat',
    '/api/hermes-openai/v1/chat/completions',
    '/api/openclaw/status',
    '/api/hermes/status',
    '/api/dsh/control-launch',
    '/api/runtime-bridges/status',
    '/api/printer-vision/status/example',
    '/api/data-toolbox/status',
    '/data-toolbox',
    '/api/ollama-vram/status',
    '/api/ollama-watchdog/status',
    '/api/analytics/federated',
    '/api/analytics/codex-usage',
    '/api/analytics/voice',
    '/api/reports/morning-brief',
    '/api/pipeline/tasks',
    '/agent-ops',
    '/voice-personas',
    '/api/finance',
    '/api/finance/inbox',
    '/api/finance/transactions',
    '/finance'
  ])('disables integration surface %s', (pathname) => {
    expect(demoSurfaceDisabled(pathname)).toBe(true);
  });

  test.each([
    '/',
    '/portal',
    '/portal/',
    '/playground',
    '/models',
    '/analytics',
    '/prompts',
    '/api/prompts',
    '/api/inference/generate',
    '/api/rag/search',
    '/api/benchmark-proxy/recommend'
  ])('keeps product surface %s', (pathname) => {
    expect(demoSurfaceDisabled(pathname)).toBe(false);
  });

  test.each(DEMO_DISABLED_PREFIXES.map((prefix) => [prefix]))(
    'documented personal prefix %s is blocked in demo and passes in full', (prefix) => {
      const guardOutcome = (profile, path) => {
        const res = {
          setHeader: jest.fn(),
          status: jest.fn(() => ({ json: jest.fn(), type: jest.fn(() => ({ send: jest.fn() })) }))
        };
        const next = jest.fn();
        createAgentXProfileGuard(profile)({ path, method: 'GET' }, res, next);
        return { blocked: next.mock.calls.length === 0, status: res.status.mock.calls[0]?.[0] };
      };
      for (const path of [prefix, `${prefix}/child`]) {
        expect(guardOutcome('demo', path)).toEqual({ blocked: true, status: 404 });
        expect(guardOutcome('full', path)).toEqual({ blocked: false, status: undefined });
      }
    }
  );

  test('guard returns a bounded JSON 404 for disabled APIs', () => {
    const json = jest.fn();
    const res = {
      setHeader: jest.fn(),
      status: jest.fn(() => ({ json }))
    };
    const next = jest.fn();

    createAgentXProfileGuard('demo')({ path: '/api/pipeline/tasks' }, res, next);

    expect(res.setHeader).toHaveBeenCalledWith('X-AgentX-Profile', 'demo');
    expect(res.status).toHaveBeenCalledWith(404);
    expect(json).toHaveBeenCalledWith(expect.objectContaining({ code: 'AGENTX_DEMO_SURFACE_DISABLED' }));
    expect(next).not.toHaveBeenCalled();
  });

  test('allows a Benchmark reservation lifecycle in demo while keeping host editing hidden', () => {
    const host = encodeURIComponent('http://127.0.0.1:11434');
    const prefix = '/api/nerve-center';
    for (const [method, path] of [
      ['POST', '/workload-admissions'],
      ['POST', '/workload-admissions/run-1/heartbeat'],
      ['POST', `/host-preferences/${host}/benchmark-claim`],
      ['POST', `/host-preferences/${host}/benchmark-claim/run-1/heartbeat`],
      ['DELETE', `/host-preferences/${host}/benchmark-claim/run-1`],
      ['POST', `/host-preferences/${host}/benchmark-claim/run-1/release-receipt`],
      ['DELETE', '/workload-admissions/run-1'],
      ['POST', '/workload-admissions/run-1/release-receipt']
    ]) expect(demoSurfaceDisabled(prefix + path, method)).toBe(false);

    expect(demoSurfaceDisabled(`${prefix}/host-preferences/${host}`, 'PUT')).toBe(true);
    expect(demoSurfaceDisabled(`${prefix}/host-preferences/${host}/swap`, 'POST')).toBe(true);
    expect(demoSurfaceDisabled(`${prefix}/maintenance-leases`, 'POST')).toBe(true);
    expect(demoSurfaceDisabled(`${prefix}/ecosystem`, 'GET')).toBe(true);
    expect(demoSurfaceDisabled(`${prefix}/workload-admissions`, 'GET')).toBe(true);
    expect(demoSurfaceDisabled('/nerve-center')).toBe(true);
  });
});
