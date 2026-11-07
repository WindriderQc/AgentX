const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.join(__dirname, '../..');
const chartsSource = fs.readFileSync(path.join(root, 'public/js/nerve-center-live-charts.js'), 'utf8');
const liveSource = fs.readFileSync(path.join(root, 'public/js/nerve-center-live.js'), 'utf8');

const escapeHtml = value => String(value ?? '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
const shared = {
  escapeHtml,
  fetchJson: async () => ({}),
  normalizeHostUrl: url => String(url || '').replace(/\/+$/, ''),
  shortModel: value => String(value),
  timeAgo: () => '5s ago',
  renderSectionLoading() {}, renderSectionError() {}, finishSectionLoad() {}
};

function load(document = { getElementById: () => null, querySelector: () => null }) {
  const window = { NerveCenterShared: shared };
  const context = { window, document, console, URL, Map, Set, Date, CSS: { escape: v => v } };
  vm.runInNewContext(chartsSource, context);
  vm.runInNewContext(liveSource, context);
  return { charts: window.NerveCenterLiveCharts, live: window.NerveCenterLive };
}

const NOW = Date.parse('2026-11-07T16:00:00Z');
const iso = msAgo => new Date(NOW - msAgo).toISOString();

describe('Nerve Center live charts', () => {
  const { charts, live } = load();

  test('power is a share of each GPU limit, unknown when a reading is missing', () => {
    expect(charts.powerPct(150, 300)).toBe(50);
    expect(charts.powerPct(500, 300)).toBe(100);
    expect(charts.powerPct(null, 300)).toBeNull();
    expect(charts.powerPct(100, 0)).toBeNull();
    expect(charts.powerPct(100, undefined)).toBeNull();
    expect(charts.powerTone(null)).toBe('unknown');
    expect(charts.powerTone(10)).toBe('idle');
    expect(charts.powerTone(60)).toBe('working');
    expect(charts.powerTone(90)).toBe('hard');
  });

  test('a gauge without a power reading says unknown, never 0', () => {
    const unknown = charts.gauge({ index: 0, name: 'NVIDIA GeForce RTX 3080 Ti', powerDraw: null, powerLimit: 400 });
    expect(unknown).toContain('—');
    expect(unknown).toContain('power unknown');
    expect(unknown).not.toMatch(/>0%</);
    expect(unknown).not.toContain('nc-gauge-needle');
    const known = charts.gauge({ index: 1, name: 'NVIDIA GeForce RTX 3090', powerDraw: 213.4, powerLimit: 300 });
    expect(known).toContain('71%');
    expect(known).toContain('213 / 300 W');
    expect(known).toContain('class="nc-gauge working"');
    expect(known).toContain('aria-label="GPU 1 power 71 percent of its limit, working"');
  });

  test('history lines break on missing readings and long gaps', () => {
    const series = [
      { t: iso(300000), w: 30, limit: 300 },
      { t: iso(270000), w: 60, limit: 300 },
      { t: iso(240000), w: null, limit: 300 },
      { t: iso(210000), w: 90, limit: 300 },
      { t: iso(30000), w: 120, limit: 300 }
    ];
    const parts = charts.runs(series, NOW - 15 * 60000, NOW);
    expect(parts.map(run => run.length)).toEqual([2, 1, 1]);
  });

  test('power chart: one line per GPU; unknown host shown as unknown', () => {
    const machine = { name: 'BigBox', address: '10.0.0.10', telemetry: { collectorHostId: 'big' }, gpus: [] };
    const power = { hosts: { big: { gpus: {
      0: [{ t: iso(60000), w: 100, limit: 300 }, { t: iso(30000), w: 150, limit: 300 }],
      1: [{ t: iso(60000), w: 20, limit: 300 }, { t: iso(30000), w: 25, limit: 300 }]
    } } } };
    const html = charts.powerChart(machine, power, NOW);
    expect((html.match(/<polyline/g) || []).length).toBe(2);
    expect(html).toContain('GPU 0');
    expect(html).toContain('GPU 1');
    expect(charts.powerChart({ ...machine, telemetry: { collectorHostId: 'gone' } }, power, NOW)).toContain('Power history unknown');
    expect(charts.powerChart(machine, null, NOW)).toContain('Power history unknown');
  });

  test('live requests card lists non-heavy requests, escaped, with Core upkeep apart', () => {
    const activity = {
      requests: { ok: true, data: { heavyWorkInFlight: 2, active: [
        { label: 'llm-gateway/<b>eko</b>', host: 'http://10.0.0.10:11434', model: 'm', stream: true, maintenance: false, state: 'ACTIVE', ageMs: 12000 },
        { label: 'Watchdog probe', host: 'http://10.0.0.10:11434', maintenance: true, state: 'ACTIVE', ageMs: 1000 }
      ] } },
      recent: { ok: true, data: { windowMinutes: 15, total: 41, perMinute: [{ t: new Date(NOW - 60000).toISOString(), n: 5, failed: 1 }],
        byCaller: [{ label: 'openclaw-runtime-bridge', n: 22 }] } }
    };
    const html = charts.requestsCard(activity, {
      machines: [{ address: '10.0.0.10', name: 'BigBox' }],
      machineNameFor: () => 'BigBox',
      jobs: [{ state: 'running', title: 'Night batch', reservation: { start: iso(600000), end: new Date(NOW + 600000).toISOString() } }],
      now: NOW
    });
    expect(html).toContain('1 now · 41 in 15 min');
    expect(html).toContain('&lt;b&gt;eko&lt;/b&gt;');
    expect(html).not.toContain('<b>eko</b>');
    expect(html).toContain('→ BigBox');
    expect(html).toContain('streaming');
    expect(html).toContain('Core upkeep: Watchdog probe');
    expect(html).toContain('Heavy work also has 2 requests in flight');
    expect(html).toContain('heavy work running');
    expect(html).toContain('nc-activity-bar failed');
    expect(html).toContain('openclaw-runtime-bridge <strong>22</strong>');
  });

  test('live requests card: empty and unavailable states', () => {
    const empty = charts.requestsCard({ requests: { ok: true, data: { active: [], heavyWorkInFlight: 0 } }, recent: { ok: false } }, { now: NOW });
    expect(empty).toContain('Nothing running through Core right now.');
    expect(empty).toContain('Recent activity unknown.');
    expect(charts.requestsCard({ requests: { ok: false } }, { now: NOW })).toContain('could not be read');
    expect(charts.callerName('agentx-household/kidx_nestor/family')).toBe('kidx_nestor/family');
  });

  test('machine cards take the full width with a power column; queue and requests share a row', async () => {
    const body = { innerHTML: '', querySelectorAll: () => [] };
    const document = { getElementById: id => (id === 'sectionLiveBody' ? body : null), querySelector: () => null, hidden: false };
    const window = { NerveCenterShared: { ...shared, fetchJson: async (url) => {
      if (url === '/api/ollama-hosts') return { data: { hosts: [{ id: 'primary', name: 'BigBox', url: 'http://10.0.0.10:11434', residency: 'gpu', available: true }] } };
      if (url.includes('gpu-status')) return { data: [{ hostId: 'primary', telemetry: { status: 'fresh', collectorHostId: 'big' },
        gpus: [{ index: 0, name: 'GPU A', powerDraw: 30, powerLimit: 300, vramUsed: 1, vramTotal: 2 }] }] };
      if (url.includes('heavy-queue')) return { data: { jobs: [] } };
      return { data: [] };
    } } };
    const context = { window, document, console, URL, Map, Set, Date, CSS: { escape: v => v } };
    vm.runInNewContext(chartsSource, context);
    vm.runInNewContext(liveSource, context);
    await window.NerveCenterLive.loadLive({ quiet: true });
    expect(body.innerHTML).toContain('nc-live-card-body');
    expect(body.innerHTML).toContain('data-power-chart="10.0.0.10"');
    expect(body.innerHTML).toContain('class="nc-gauge idle"');
    expect(body.innerHTML).toMatch(/nc-live-pair[\s\S]*Heavy-work queue[\s\S]*id="ncLiveRequests"/);
  });

  test('without the charts script the live view still renders', () => {
    expect(typeof live.groupMachines).toBe('function');
  });
});
