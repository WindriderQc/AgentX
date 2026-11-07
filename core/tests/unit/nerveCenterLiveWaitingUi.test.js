const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.join(__dirname, '../..');
const liveSource = fs.readFileSync(path.join(root, 'public/js/nerve-center-live.js'), 'utf8');

const escapeHtml = value => String(value ?? '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

function load({ fetchJson = async () => ({}), document = { getElementById: () => null, querySelector: () => null } } = {}) {
  const window = { NerveCenterShared: {
    fetchJson, escapeHtml,
    normalizeHostUrl: url => String(url || '').replace(/\/+$/, ''),
    shortModel: value => String(value),
    timeAgo: () => '5s ago',
    motionSafeScrollBehavior: () => 'auto',
    renderSectionLoading() {}, renderSectionError() {}, finishSectionLoad() {}
  } };
  vm.runInNewContext(liveSource, { window, document, console, URL, Map, Set, Date, CSS: { escape: v => v } });
  return window.NerveCenterLive;
}

const NOW = Date.parse('2026-11-07T17:00:00Z');
const machines = [
  { address: '10.0.0.10', name: 'BigBox' },
  { address: '10.0.0.20', name: 'SmallBox' }
];

const jobs = [
  {
    id: 'j1', title: 'Parity run <script>', state: 'requested', priority: 0,
    hosts: ['http://10.0.0.10:11434', 'http://10.0.0.10:18080', 'http://10.0.0.20:11434'],
    estimatedMinutes: 190, notBefore: '2026-11-07T22:00:00Z', startBefore: '2026-11-08T10:00:00Z',
    createdAt: '2026-11-07T15:00:00Z',
    source: { type: 'coding_session', ref: 'Compare the two runtimes on the same prompts. '.repeat(8),
      taskId: 'task-42', issueUrl: 'https://github.com/Example/Product/issues/1310' },
    events: [{ at: '2026-11-07T15:00:00Z', actor: 'codex-parity-<b>1310</b>', action: 'requested' }],
    presentation: { nextAction: { code: 'plan_slot', actor: 'operator', detail: 'Plan a slot.' } }
  },
  {
    id: 'j2', title: 'Old reservation', state: 'reserved', priority: 5,
    hosts: ['http://10.0.0.20:11434'], estimatedMinutes: 45,
    notBefore: '2026-11-06T01:00:00Z', startBefore: '2026-11-06T05:00:00Z',
    createdAt: '2026-11-06T00:00:00Z',
    reservation: { start: '2026-11-06T02:00:00Z', end: '2026-11-06T03:00:00Z' },
    source: { type: 'manual' }, events: [],
    presentation: { nextAction: { code: 'review_window' } }
  },
  { id: 'j3', title: 'Upcoming', state: 'reserved', hosts: ['http://10.0.0.10:11434'],
    reservation: { start: '2026-11-07T20:00:00Z', end: '2026-11-07T21:00:00Z' } },
  { id: 'j4', title: 'Done', state: 'completed', hosts: ['http://10.0.0.10:11434'] }
];

describe('Nerve Center heavy-queue waiting list', () => {
  const live = load();

  test('lists every request without a usable slot, with what it needs and why it waits', () => {
    const html = live.renderQueueCard(jobs, [], machines, NOW, true);
    expect(html).toContain('<details class="nc-live-waiting">');
    expect(html).toContain('1 waiting for a slot · 1 with an expired slot');
    expect((html.match(/class="nc-live-waiting-item/g) || []).length).toBe(2);
    // Higher priority first.
    expect(html.indexOf('Old reservation')).toBeLessThan(html.indexOf('Parity run'));

    expect(html).toContain('BigBox, SmallBox');
    expect(html).toContain('3 h 10 min');
    expect(html).toContain('45 min');
    expect(html).toContain('No slot planned yet');
    expect(html).toContain('Its start window or slot has expired');
    expect(html).toContain('nc-live-waiting-item expired');
    expect(html).toContain('start window closed');
    expect(html).toContain('slot passed');
    expect(html).toContain('task task-42');
    expect(html).toContain('<a href="https://github.com/Example/Product/issues/1310" target="_blank" rel="noopener">Product#1310</a>');
    expect(html).toContain('manual');
    expect(html).toContain('…');
  });

  test('escapes request text and offers no queue action', () => {
    const html = live.renderQueueCard(jobs, [], machines, NOW, true);
    expect(html).toContain('Parity run &lt;script&gt;');
    expect(html).toContain('codex-parity-&lt;b&gt;1310&lt;/b&gt;');
    expect(html).not.toContain('<script>');
    expect(html).not.toContain('<b>1310</b>');
    const waiting = html.slice(html.indexOf('<details'), html.indexOf('</details>'));
    expect(waiting).not.toMatch(/<button|<form|<input|<select/);
    expect(waiting).toContain('Read-only.');
  });

  test('no list when nothing waits', () => {
    const html = live.renderQueueCard([jobs[2]], [], machines, NOW, true);
    expect(html).not.toContain('nc-live-waiting');
  });

  test('reason falls back to Core detail, then to the phase', () => {
    expect(live.waitReason({ presentation: { nextAction: { code: 'new_code', detail: 'Core says why' } } }, 'waiting')).toBe('Core says why');
    expect(live.waitReason({}, 'expired')).toMatch(/expired/);
    expect(live.waitReason({}, 'waiting')).toBe('Waiting for a slot');
    expect(live.durationText(null)).toBe('unknown');
    expect(live.durationText(120)).toBe('2 h');
  });

  test('machine card counts waiting and expired requests and links to the list', () => {
    const work = live.machineWork({ address: '10.0.0.20', endpoints: [] }, jobs, [], NOW);
    expect(work.waiting).toBe(2);
  });

  test('the machine link opens the list, and the open state survives a refresh', async () => {
    const listeners = {};
    const details = {
      open: false,
      addEventListener: (name, fn) => { listeners[name] = fn; },
      querySelector: () => ({ focus() {} }),
      scrollIntoView() { details.scrolled = true; }
    };
    const showButton = { addEventListener: (name, fn) => { listeners.show = fn; } };
    const body = {
      innerHTML: '',
      querySelectorAll: selector => (selector === '.nc-live-show-waiting' ? [showButton] : []),
      querySelector: selector => (selector === '.nc-live-waiting' ? details : null)
    };
    const document = {
      getElementById: id => (id === 'sectionLiveBody' ? body : null),
      querySelector: selector => (selector === '.nc-live-waiting' ? details : null),
      hidden: false
    };
    const fetchJson = async url => {
      if (url === '/api/ollama-hosts') return { data: { hosts: [{ id: 'small', name: 'SmallBox', url: 'http://10.0.0.20:11434', residency: 'gpu', available: true }] } };
      if (url.includes('heavy-queue')) return { data: { jobs } };
      return { data: [] };
    };
    const liveDom = load({ fetchJson, document });
    await liveDom.loadLive({ quiet: true });
    expect(body.innerHTML).toContain('2 waiting in the queue · show which');
    expect(body.innerHTML).toContain('<details class="nc-live-waiting">');

    listeners.show();
    expect(details.open).toBe(true);
    expect(details.scrolled).toBe(true);

    await liveDom.loadLive({ quiet: true });
    expect(body.innerHTML).toContain('<details class="nc-live-waiting" open>');

    details.open = false;
    listeners.toggle();
    await liveDom.loadLive({ quiet: true });
    expect(body.innerHTML).toContain('<details class="nc-live-waiting">');
  });
});
