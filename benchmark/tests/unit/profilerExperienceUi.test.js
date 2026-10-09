const fs = require('fs');
const path = require('path');
const vm = require('vm');

async function render(readiness, { unavailable = false, recovery = {} } = {}) {
    const elements = {};
    function element(id) {
        return elements[id] ||= { listeners: {}, addEventListener(type, callback) { this.listeners[type] = callback; },
            querySelector: () => element(id + '-child'), setAttribute() {}, removeAttribute() {} };
    }
    let ready;
    const payloads = {
        '/benchmark/api/ollama-hosts': { hosts: [{ available: true, models: ['model'] }] },
        '/benchmark/api/profiler/hosts': { data: [{ baseline: { testedAt: '2026-09-09' } }] },
        '/benchmark/api/profiler/models': { data: [{ stage: 'profiled', readiness: { primary: readiness } }] },
        '/benchmark/api/profiler/recovery': { data: { schema: 'agentx.profiler-recovery-view/v1', observedAt: new Date().toISOString(), operations: [] } }
    };
    vm.runInNewContext(fs.readFileSync(path.resolve(__dirname, '../../public/js/model-profiler/experience.js'), 'utf8'), {
        window: { ProfilerRecovery: { render: () => recovery }, addEventListener() {} },
        document: { getElementById: element, querySelectorAll: () => [], addEventListener: (_type, callback) => { ready = callback; } },
        fetch: async url => {
            if (unavailable && url === '/benchmark/api/profiler/models') throw new Error('unavailable');
            return { ok: true, json: async () => payloads[url] };
        }, AbortController, setTimeout: (callback, delay) => delay === 15000 ? null : setTimeout(callback, delay), clearTimeout
    });
    element('profiler-primary-action').dataset = {};
    ready();
    await new Promise(resolve => setImmediate(resolve));
    return elements;
}

test.each([
    { stage: 'profiled', stale: true, benchmarkQualified: false, authority: { verified: false } },
    { stage: 'benchmarked', stale: false, benchmarkQualified: true, authority: { verified: false } }
])('does not declare stale or unverified profiles prepared', async readiness => {
    const elements = await render(readiness);
    expect(elements['profiler-experience-status-label'].textContent).toBe('Profile the contenders');
    expect(elements['profiler-models-detail'].textContent).toContain('0 ready');
});

test('uses verified current evidence to declare comparison readiness', async () => {
    const elements = await render({ stage: 'profiled', stale: false, benchmarkQualified: true, authority: { verified: true } });
    expect(elements['profiler-experience-status-label'].textContent).toBe('Prepared for comparison');
});

test('reports unavailable evidence as unknown', async () => {
    const elements = await render(null, { unavailable: true });
    expect(elements['profiler-experience-status-label'].textContent).toBe('Preparation status is unknown');
});

test.each([{ unknown: true }, { pending: 1, attention: 1 }])('does not declare prepared comparisons while runtime recovery needs inspection', async recovery => {
    const elements = await render({ benchmarkQualified: true, stale: false, authority: { verified: true } }, { recovery });
    expect(elements['profiler-experience-status-label'].textContent).not.toBe('Prepared for comparison');
    expect(elements['profiler-primary-action'].dataset.profilerTarget).toBe('profiler-recovery');
    expect(elements['profiler-primary-label'].textContent).toBe('Inspect runtime continuity');
});
