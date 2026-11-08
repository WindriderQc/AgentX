'use strict';

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const scriptsRoot = path.resolve(__dirname, '../../public/js');
const settled = () => new Promise(setImmediate);
const energyData = power => ({
  latest: { power: power === null ? null : { value: power } },
  summary: { energyKwh: 0, baselineW: 0, attributedWh: 0, eventCount: 0 },
  series: { power: [{ at: '2026-11-08T00:00:00Z', value: power }] }, events: [], freshness: null,
  methodology: { note: 'Synthetic correlation, not per-process measurement.' },
  from: '2026-11-08T00:00:00Z', to: '2026-11-08T01:00:00Z'
});

function browser({ hidden = false } = {}) {
  const requests = [], timers = new Map(), nodes = new Map(), charts = [];
  const docListeners = new Map(), winListeners = new Map();
  let timerId = 0;
  const node = () => ({ textContent: '', className: '', attributes: {}, dataset: {}, handlers: {},
    setAttribute(key, value) { this.attributes[key] = value; },
    addEventListener(type, fn) { this.handlers[type] = fn; } });
  const buttons = ['6h', '24h', '7d', '30d'].map(value => Object.assign(node(), { dataset: { window: value } }));
  const listen = (map, type, fn) => {
    if (!map.has(type)) map.set(type, new Set());
    map.get(type).add(fn);
  };
  const dispatch = (map, type, event = {}) => { for (const fn of [...(map.get(type) || [])]) fn(event); };
  const document = {
    hidden,
    getElementById(id) { if (!nodes.has(id)) nodes.set(id, node()); return nodes.get(id); },
    querySelectorAll: () => buttons,
    addEventListener: (type, fn) => listen(docListeners, type, fn),
    removeEventListener: (type, fn) => docListeners.get(type)?.delete(fn)
  };
  const window = {
    addEventListener: (type, fn) => listen(winListeners, type, fn),
    removeEventListener: (type, fn) => winListeners.get(type)?.delete(fn)
  };
  const context = vm.createContext({ document, window, AbortController, console,
    Chart: class {
      constructor(_element, config) { this.config = config; this.destroyed = false; charts.push(this); }
      destroy() { this.destroyed = true; }
    },
    setInterval(fn, ms) { timers.set(++timerId, { fn, ms }); return timerId; },
    clearInterval: id => timers.delete(id),
    // Intentionally ignore abort here, as a late body/cached response must still
    // be fenced before it can change the DOM.
    fetch: (url, options) => new Promise((resolve, reject) => requests.push({ url, options, resolve, reject }))
  });
  for (const file of ['utils/polling-controller-global.js', 'energy.js']) {
    vm.runInContext(fs.readFileSync(path.join(scriptsRoot, file), 'utf8'), context, { filename: file });
  }
  return {
    requests, timers, nodes, charts, buttons, document, docListeners,
    click(value) { buttons.find(button => button.dataset.window === value).handlers.click(); },
    tick() { for (const timer of [...timers.values()]) timer.fn(); },
    visibility(value) { document.hidden = value; dispatch(docListeners, 'visibilitychange'); },
    pagehide() { dispatch(winListeners, 'pagehide', { persisted: true }); },
    pageshow() { dispatch(winListeners, 'pageshow', { persisted: true }); },
    async reply(index, power, { ok = true, message } = {}) {
      requests[index].resolve({ ok, json: async () => ({ message, data: energyData(power) }) });
      await settled();
    }
  };
}

describe('Energy page polling lifecycle', () => {
  test('a late response cannot overwrite the selected period', async () => {
    const page = browser();
    page.click('7d');
    expect(page.requests.map(read => read.url)).toEqual(['/api/analytics/energy?window=24h', '/api/analytics/energy?window=7d']);
    await page.reply(1, 7); await page.reply(0, 24);
    expect(page.nodes.get('energyPower').textContent).toBe('7 W');
    expect(page.charts.at(-1).config.data.datasets[0].data[0].y).toBe(7);
    expect(page.buttons.find(button => button.dataset.window === '7d').attributes['aria-pressed']).toBe('true');
  });

  test('slow polling does not overlap reads and keeps the 30-second frequency', async () => {
    const page = browser(); page.tick(); page.tick();
    expect(page.requests).toHaveLength(1);
    expect([...page.timers.values()].map(timer => timer.ms)).toEqual([30_000]);
    await page.reply(0, 24); page.tick();
    expect(page.requests).toHaveLength(2);
  });

  test('leaving the page stops the timer and prevents a late response from rendering', async () => {
    const page = browser(); page.pagehide();
    expect(page.timers.size).toBe(0);
    await page.reply(0, 9);
    expect(page.charts).toHaveLength(0);
    expect(page.requests[0].options.signal.aborted).toBe(true);
  });

  test('rapidly returning to the same period still ignores the earlier request for that period', async () => {
    const page = browser(); page.click('7d'); page.click('24h');
    expect(page.requests.slice(0, 2).every(read => read.options.signal.aborted)).toBe(true);
    await page.reply(2, 20); await page.reply(0, 10); await page.reply(1, 7);
    expect(page.nodes.get('energyPower').textContent).toBe('20 W');
    expect(page.timers.size).toBe(1);
  });

  test('a late body after headers cannot replace the selected period', async () => {
    const page = browser(); let finishBody;
    page.requests[0].resolve({ ok: true, json: () => new Promise(resolve => { finishBody = resolve; }) });
    await settled(); page.click('7d'); await page.reply(1, 7);
    finishBody({ data: energyData(24) }); await settled();
    expect(page.nodes.get('energyPower').textContent).toBe('7 W');
    expect(page.requests[0].options.signal.aborted).toBe(true);
  });

  test('a superseded failure cannot replace a newer success or its notice', async () => {
    const page = browser(); page.click('7d'); await page.reply(1, 7);
    page.requests[0].reject(new Error('obsolete failure')); await settled();
    expect(page.nodes.get('energyPower').textContent).toBe('7 W');
    expect(page.nodes.get('energyNotice').textContent).toBe('Fraîcheur inconnue');
    expect(page.nodes.get('energyNotice').className).toBe('energy-notice');
  });

  test('hidden pages do not fetch and resume with one read and one timer', async () => {
    const page = browser({ hidden: true });
    expect(page.requests).toHaveLength(0); expect(page.timers.size).toBe(0);
    page.visibility(false);
    expect(page.requests).toHaveLength(1); expect(page.timers.size).toBe(1);
    page.visibility(true);
    expect(page.requests[0].options.signal.aborted).toBe(true); expect(page.timers.size).toBe(0);
    await page.reply(0, 99); expect(page.charts).toHaveLength(0);
    page.visibility(false); page.visibility(false);
    expect(page.requests).toHaveLength(2); expect(page.timers.size).toBe(1);
    await page.reply(1, 24); expect(page.nodes.get('energyPower').textContent).toBe('24 W');
  });

  test('BFCache restoration starts one fresh cycle even while an aborted poll has not settled', async () => {
    const page = browser(); await page.reply(0, 24); page.tick();
    expect(page.requests).toHaveLength(2);
    page.pagehide(); page.pagehide();
    expect(page.timers.size).toBe(0);
    expect(page.docListeners.get('visibilitychange').size).toBe(0);
    expect(page.requests[1].options.signal.aborted).toBe(true);
    page.pageshow(); page.pageshow();
    expect(page.timers.size).toBe(1); expect(page.requests).toHaveLength(3);
    await page.reply(2, 25); page.tick();
    expect(page.requests).toHaveLength(4);
    await page.reply(1, 999); page.tick();
    expect(page.requests).toHaveLength(4); expect(page.nodes.get('energyPower').textContent).toBe('25 W');
    await page.reply(3, 26); expect(page.nodes.get('energyPower').textContent).toBe('26 W');
  });

  test('current errors remain visible and a later poll can recover without inventing a measurement', async () => {
    const page = browser();
    await page.reply(0, null, { ok: false, message: 'Energy source unavailable' });
    expect(page.nodes.get('energyNotice').textContent).toBe('Energy source unavailable');
    expect(page.nodes.get('energyNotice').className).toBe('energy-notice error');
    page.tick(); page.requests[1].reject(new Error('network unavailable')); await settled();
    expect(page.nodes.get('energyNotice').textContent).toBe('network unavailable');
    page.tick(); await page.reply(2, null);
    expect(page.nodes.get('energyPower').textContent).toBe('— W');
    expect(page.nodes.get('energyNotice').className).toBe('energy-notice');
    expect(page.nodes.get('energyMethod').textContent).toBe('Synthetic correlation, not per-process measurement.');
  });
});
