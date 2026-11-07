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
    expect(html).toContain('1 now · 5 in 15 min');
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

  test('requests per minute: stacked ok and failed segments, legend, scale, time ticks', () => {
    const t = msAgo => new Date(Math.floor((NOW - msAgo) / 60000) * 60000).toISOString();
    const html = charts.activityChart({ windowMinutes: 15, total: 25, perMinute: [
      { t: t(120000), n: 20, failed: 1 },
      { t: t(60000), n: 5, failed: 0 }
    ] }, [], NOW);
    expect((html.match(/class="nc-activity-bar"/g) || []).length).toBe(2);
    expect((html.match(/class="nc-activity-bar failed"/g) || []).length).toBe(1);
    expect(html).toContain('ok 24');
    expect(html).toContain('failed 1');
    expect(html).not.toContain('heavy work running');
    expect(html).toMatch(/nc-activity-scale[^>]*><span>20<\/span><span>0<\/span>/);
    expect((html.match(/nc-activity-ticks[\s\S]*?<\/div>/)[0].match(/<span/g) || []).length).toBe(3);
    expect((html.match(/data-minute="/g) || []).length).toBe(15);
    expect(html).toContain('20 requests, 1 failed');
    expect(html).toContain('Tap a bar');

    const overlapping = charts.activityChart({ windowMinutes: 15, total: 0, perMinute: [] }, [
      { start: NOW - 3600000, end: NOW, title: 'Long run' },
      { start: NOW - 300000, end: NOW, title: 'Short run' }
    ], NOW);
    expect((overlapping.match(/class="nc-activity-heavy"/g) || []).length).toBe(1);
    expect(overlapping).toContain('Heavy work: Long run · Short run');
  });

  test('a tapped minute lists its requests with plain reasons, survives a repaint, and closes', async () => {
    const listeners = [];
    const card = {
      innerHTML: '',
      querySelectorAll: () => [],
      querySelector: () => null
    };
    const document = { getElementById: id => (id === 'ncLiveRequests' ? card : null), querySelector: () => null, activeElement: null, hidden: false };
    // paint() draws against the real clock: pick a minute inside its window.
    const minute = Math.floor((Date.now() - 60000) / 60000) * 60000;
    const urls = [];
    const window = { NerveCenterShared: { ...shared, fetchJson: async (url) => {
      urls.push(url);
      if (url.startsWith('/api/nerve-center/live-activity/minute')) {
        return { data: { minute: new Date(minute).toISOString(), total: 2, truncated: false, requests: [
          { caller: 'llm-gateway/eko', host: 'http://10.0.0.10:11434', model: 'm', durationMs: 850, status: 'success', reason: null },
          { caller: 'rag-<i>x</i>', host: 'http://10.0.0.10:11434', model: 'm', durationMs: 120000, status: 'timeout', reason: 'upstream_timeout' }
        ] } };
      }
      return { data: { requests: { ok: true, data: { active: [], heavyWorkInFlight: 0 } },
        recent: { ok: true, data: { windowMinutes: 15, total: 2, perMinute: [{ t: new Date(minute).toISOString(), n: 2, failed: 1 }], byCaller: [] } } } };
    } } };
    const context = { window, document, console, URL, Map, Set, Date, CSS: { escape: v => v } };
    vm.runInNewContext(chartsSource, context);
    const c = window.NerveCenterLiveCharts;
    c.attach({ machines: [{ address: '10.0.0.10', name: 'BigBox' }], jobs: [], machineNameFor: () => 'BigBox' });
    await c.refresh();
    expect(card.innerHTML).toContain('Full history');
    expect(card.innerHTML).toContain('href="/analytics"');
    expect(card.innerHTML).toContain('<h3 id="ncLiveRequestsTitle">Live requests</h3>');

    await c.selectMinute(minute);
    expect(urls.some(u => u.includes(`at=${encodeURIComponent(new Date(minute).toISOString())}`))).toBe(true);
    expect(card.innerHTML).toContain('2 requests · 1 failed');
    expect(card.innerHTML).toContain('eko');
    expect(card.innerHTML).toContain('→ BigBox');
    expect(card.innerHTML).toContain('850 ms');
    expect(card.innerHTML).toContain('timed out');
    expect(card.innerHTML).toContain('rag-&lt;i&gt;x&lt;/i&gt;');
    expect(card.innerHTML).toContain('nc-activity-minute selected');

    await c.refresh();
    expect(card.innerHTML).toContain('2 requests · 1 failed');

    await c.selectMinute(minute);
    expect(card.innerHTML).not.toContain('nc-minute-head');
    expect(card.innerHTML).toContain('Tap a bar');
    expect(c.reasonText('workload_reserved')).toBe('machine reserved for heavy work');
    expect(c.reasonText('some_new_code')).toBe('some new code');
    expect(listeners).toEqual([]);
  });

  test('without the charts script the live view still renders', () => {
    expect(typeof live.groupMachines).toBe('function');
  });
});
