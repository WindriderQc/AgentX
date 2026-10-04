const fs = require('fs');
const path = require('path');
const vm = require('vm');

const source = fs.readFileSync(path.join(__dirname, '../../public/js/nerve-center-ops-watch.js'), 'utf8');

// A submit listener starts its work without returning it: let it settle.
const settle = () => new Promise(resolve => setImmediate(resolve));

function escapeHtml(value) {
  return String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// A node that hands out one stable child per selector, like the rendered section.
function fakeNode() {
  const children = new Map();
  const classes = new Set();
  const node = {
    innerHTML: '', textContent: '', className: '', hidden: true, disabled: false, listeners: {},
    classList: { add: name => classes.add(name), remove: name => classes.delete(name), contains: name => classes.has(name) },
    addEventListener: (name, listener) => { node.listeners[name] = listener; },
    querySelector(selector) {
      if (!children.has(selector)) children.set(selector, fakeNode());
      return children.get(selector);
    }
  };
  return node;
}

const SETTINGS = { enabled: true, intervalMinutes: 15, language: 'French', source: 'environment', minMinutes: 5, maxMinutes: 1440 };
const FINDINGS = [
  { key: 'issue:host_offline:secondary', severity: 'critical', text: 'Host offline' },
  { key: 'alert:disk:tertiary', severity: 'attention', text: 'Disk 91%' },
  { key: 'alert:spill:tertiary', severity: 'attention', text: 'CPU spill' }
];

async function harness(data, { fetchJson } = {}) {
  const body = fakeNode();
  const summary = fakeNode();
  const calls = [];
  const request = fetchJson || (async (url, options) => {
    calls.push({ url, options });
    return { status: 'success', data };
  });
  const window = { NerveCenterShared: {
    fetchJson: request, escapeHtml,
    renderSectionError(_body, message) { throw new Error(message); }, finishSectionLoad() {}
  } };
  const document = {
    readyState: 'loading', addEventListener() {},
    getElementById: id => (id === 'sectionOpsWatchBody' ? body : id === 'nc-ops-watch-summary' ? summary : null)
  };
  vm.runInNewContext(source, { window, document, setTimeout: jest.fn(() => 1), clearTimeout: jest.fn() });
  await window.NerveCenterOpsWatch.loadOpsWatch();
  return { body, summary, calls, report: body.querySelector('.nc-ops-watch-report') };
}

describe('Nerve Center operations watch UI', () => {
  it('shows a clear state with the schedule beside it', async () => {
    const { report, summary, body } = await harness({
      report: { at: '2026-10-03T23:24:51.000Z', findingCount: 0, findings: [], summary: null, source: 'rules' },
      settings: SETTINGS, scheduled: true, checking: false
    });
    expect(report.innerHTML).toContain('nc-watch is-clear');
    expect(report.innerHTML).toContain('Nothing needs attention');
    expect(report.innerHTML).toContain('Every 15 min');
    expect(report.innerHTML).not.toContain('nc-watch-report');
    expect(summary.textContent).toBe('Nothing needs attention');
    expect(body.innerHTML).toContain('From the configuration file until saved here');
  });

  it('counts findings by severity and escapes the model report', async () => {
    const { report, summary } = await harness({
      report: { at: '2026-10-03T23:24:51.000Z', findingCount: 3, findings: FINDINGS,
        summary: '1. <b>Tower</b> offline', source: 'model', model: 'gemma4:12b' },
      settings: SETTINGS, scheduled: true, checking: false
    });
    expect(report.innerHTML).toContain('nc-watch is-critical');
    expect(report.innerHTML).toContain('3 findings need attention');
    expect(report.innerHTML).toContain('1 critical');
    expect(report.innerHTML).toContain('2 attention');
    expect(report.innerHTML).toContain('Written by gemma4:12b');
    expect(report.innerHTML).toContain('1. &lt;b&gt;Tower&lt;/b&gt; offline');
    expect(summary.textContent).toBe('3 findings');
    expect(summary.className).toBe('nc-section-summary critical');
  });

  it('says when the plain rule list replaces an unavailable model', async () => {
    const { report, summary } = await harness({
      report: { at: '2026-10-03T23:24:51.000Z', findingCount: 1, findings: [FINDINGS[1]],
        summary: '- [attention] Disk 91%', source: 'rules', modelUnavailable: 'HOST_BUSY' },
      settings: SETTINGS, scheduled: true, checking: false
    });
    expect(report.innerHTML).toContain('nc-watch is-findings');
    expect(report.innerHTML).toContain('1 finding needs attention');
    expect(report.innerHTML).toContain('Rule list, model unavailable (HOST_BUSY)');
    expect(report.innerHTML).not.toContain('critical');
    expect(summary.className).toBe('nc-section-summary attention');
  });

  it.each([
    [{ ...SETTINGS, enabled: false }, false, 'Automatic checks off'],
    [SETTINGS, false, 'On, not scheduled in this process']
  ])('reports a watch that is not running', async (settings, scheduled, label) => {
    const { report } = await harness({ report: null, settings, scheduled, checking: false });
    expect(report.innerHTML).toContain('nc-watch is-idle');
    expect(report.innerHTML).toContain('No check since Core started');
    expect(report.innerHTML).toContain(label);
    expect(report.innerHTML).not.toContain('Every 15 min');
  });

  it('draws the automatic check as a labelled switch that keeps its state', async () => {
    const data = { report: null, settings: SETTINGS, scheduled: true, checking: false };
    const on = await harness(data);
    expect(on.body.innerHTML).toMatch(/<label class="nc-switch"><input type="checkbox" name="enabled" checked>/);
    expect(on.body.innerHTML).toContain('Check automatically</label>');
    const off = await harness({ ...data, settings: { ...SETTINGS, enabled: false, source: 'saved' } });
    expect(off.body.innerHTML).toMatch(/<input type="checkbox" name="enabled">/);
    expect(off.body.innerHTML).toContain('Saved here');
  });

  it('announces a check that could not start instead of hiding it in a tooltip', async () => {
    const data = { report: null, settings: SETTINGS, scheduled: true, checking: false };
    const fetchJson = jest.fn(async (url, options) => {
      if (options?.method === 'POST') throw new Error('Core is restarting');
      return { status: 'success', data };
    });
    const { report } = await harness(data, { fetchJson });
    expect(report.innerHTML).toContain('nc-ops-watch-error" role="alert" hidden');
    const button = report.querySelector('.nc-ops-watch-check');
    await button.listeners.click({ currentTarget: button });
    const error = report.querySelector('.nc-ops-watch-error');
    expect(error.textContent).toBe('The check did not start: Core is restarting');
    expect(error.hidden).toBe(false);
    expect(button.disabled).toBe(false);
  });

  it('saves the three settings and marks a refusal as an error', async () => {
    const data = { report: null, settings: SETTINGS, scheduled: true, checking: false };
    const fetchJson = jest.fn(async (url, options) => {
      if (options?.method === 'PUT') throw new Error('Report language is required');
      return { status: 'success', data };
    });
    const { body } = await harness(data, { fetchJson });
    const form = fakeNode();
    form.elements = { enabled: { checked: false }, intervalMinutes: { value: '30' }, language: { value: ' English ' } };
    await body.querySelector('.nc-ops-watch-settings').listeners.submit({ preventDefault() {}, currentTarget: form });
    await settle();
    const [url, options] = fetchJson.mock.calls.find(([, options]) => options?.method === 'PUT');
    expect(url).toBe('/api/nerve-center/ops-watch/settings');
    expect(JSON.parse(options.body)).toEqual({ enabled: false, intervalMinutes: 30, language: 'English' });
    const status = form.querySelector('.nc-ops-watch-status');
    expect(status.textContent).toBe('Report language is required');
    expect(status.classList.contains('is-error')).toBe(true);
  });
});
