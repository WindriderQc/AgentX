const fs = require('fs');
const path = require('path');
const vm = require('vm');
const upcoming = require('../../public/js/cluster-schedule-upcoming.js');
const headline = require('../../public/js/cluster-schedule-headline.js');

const root = path.resolve(__dirname, '../..');
const read = relative => fs.readFileSync(path.join(root, relative), 'utf8');

function slot(start, durationMs = 60_000) {
  return {
    start: new Date(start).toISOString(),
    end: new Date(start + durationMs).toISOString()
  };
}

function frequentEntry({
  id = 'gmail-triage',
  name = 'Gmail triage',
  start = Date.parse('2026-08-28T00:00:00.000Z'),
  count = 20,
  intervalMs = 5 * 60_000
} = {}) {
  return {
    id,
    name,
    source: 'agentx-system',
    taskType: 'sync',
    scheduleType: 'cron',
    host: null,
    slots: Array.from({ length: count }, (_, index) => slot(start + index * intervalMs))
  };
}

function loadClusterScheduleContext() {
  const elements = new Map();
  const document = {
    addEventListener: jest.fn(),
    querySelectorAll: jest.fn(() => []),
    querySelector: jest.fn(() => null),
    getElementById: jest.fn(id => {
      if (!elements.has(id)) {
        elements.set(id, {
          innerHTML: '',
          style: {},
          setAttribute: jest.fn(),
          classList: { add: jest.fn(), remove: jest.fn(), toggle: jest.fn(), contains: jest.fn() }
        });
      }
      return elements.get(id);
    })
  };
  const window = {
    ClusterScheduleDate: {
      browserTimeZone: () => 'UTC',
      localDateKey: () => '2026-08-28',
      isToday: () => true,
      formatCalendarDate: value => value,
      describeCalendarDate: value => ({ label: value }),
      addCalendarDays: value => value
    },
    ClusterScheduleUpcoming: upcoming,
    ClusterScheduleHeadline: headline,
    AgentXUtils: { escapeHtml: value => String(value) },
    addEventListener: jest.fn(),
    innerWidth: 1280,
    innerHeight: 720
  };
  const context = vm.createContext({
    window,
    document,
    console,
    fetch: jest.fn(),
    setInterval: jest.fn(),
    clearInterval: jest.fn()
  });
  vm.runInContext(read('public/js/cluster-schedule.js'), context);
  vm.runInContext(read('public/js/cluster-schedule-attention.js'), context);
  vm.runInContext(read('public/js/cluster-schedule-actual.js'), context);
  vm.runInContext(read('public/js/cluster-schedule-services.js'), context);
  return { context, elements };
}

describe('Cluster Schedule upcoming-task projection', () => {
  test('collapses a frequent job to its next fire and remaining occurrence count', () => {
    const now = Date.parse('2026-08-28T00:02:00.000Z');
    const frequent = frequentEntry();
    const separate = {
      id: 'benchmark-daily',
      name: 'Daily benchmark',
      source: 'agentx',
      taskType: 'benchmark',
      scheduleType: 'cron',
      slots: [slot(Date.parse('2026-08-28T00:03:00.000Z'))]
    };

    const result = upcoming.buildUpcomingTasks([frequent, separate], {
      now,
      todaySelected: true,
      formatTime: value => value
    });

    expect(result.map(item => item.name)).toEqual(['Daily benchmark', 'Gmail triage']);
    const gmail = result.find(item => item.id.startsWith('gmail-triage-'));
    expect(result.filter(item => item.name === 'Gmail triage')).toHaveLength(1);
    expect(gmail).toMatchObject({
      nextRun: '2026-08-28T00:05:00.000Z',
      intervalMs: 5 * 60_000,
      collapsedOccurrences: true,
      occurrenceCount: 19,
      occurrenceLabel: '19 remaining today',
      displayMode: 'countdown'
    });
  });

  test('keeps distinct frequent jobs separate even when their display names match', () => {
    const result = upcoming.buildUpcomingTasks([
      frequentEntry({ id: 'gmail-personal' }),
      frequentEntry({ id: 'gmail-work' })
    ], {
      now: Date.parse('2026-08-27T23:59:00.000Z'),
      todaySelected: true
    });

    expect(result).toHaveLength(2);
    expect(result.map(item => item.id)).toEqual(expect.arrayContaining([
      expect.stringContaining('gmail-personal-'),
      expect.stringContaining('gmail-work-')
    ]));
  });

  test('does not collapse ordinary low-frequency occurrences', () => {
    const result = upcoming.buildUpcomingTasks([{
      id: 'twice-daily',
      name: 'Twice daily review',
      scheduleType: 'cron',
      taskType: 'maintenance',
      slots: [
        slot(Date.parse('2026-08-28T09:00:00.000Z')),
        slot(Date.parse('2026-08-28T17:00:00.000Z'))
      ]
    }], {
      now: Date.parse('2026-08-28T08:00:00.000Z'),
      todaySelected: true
    });

    expect(result).toHaveLength(2);
    expect(result.every(item => item.collapsedOccurrences === false)).toBe(true);
  });

  test('preserves selected future-day clock display while collapsing recurrence rows', () => {
    const futureStart = Date.parse('2026-08-29T10:00:00.000Z');
    const result = upcoming.buildUpcomingTasks([
      frequentEntry({ start: futureStart, count: 13 })
    ], {
      now: Date.parse('2026-08-28T12:00:00.000Z'),
      todaySelected: false,
      formatTime: value => `clock:${value}`
    });

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      nextRun: '2026-08-29T10:00:00.000Z',
      displayMode: 'time',
      displayText: 'clock:2026-08-29T10:00:00.000Z',
      occurrenceCount: 13,
      occurrenceLabel: '13 on selected day'
    });
  });

  test('never lists finished occurrences, even when a past day is selected', () => {
    const result = upcoming.buildUpcomingTasks([{
      id: 'nightly',
      name: 'Nightly benchmark',
      scheduleType: 'cron',
      taskType: 'benchmark',
      slots: [slot(Date.parse('2026-08-27T02:00:00.000Z'), 7_200_000)]
    }], {
      now: Date.parse('2026-08-28T12:00:00.000Z'),
      todaySelected: false
    });

    expect(result).toEqual([]);
  });

  test('marks an occurrence inside its window as running rather than due', () => {
    const [task] = upcoming.buildUpcomingTasks([{
      id: 'nightly',
      name: 'Nightly benchmark',
      scheduleType: 'cron',
      taskType: 'benchmark',
      slots: [slot(Date.parse('2026-08-28T02:00:00.000Z'), 7_200_000)]
    }], {
      now: Date.parse('2026-08-28T02:30:00.000Z'),
      todaySelected: true
    });

    expect(task).toMatchObject({ running: true, msFromNow: 0 });
  });

  test('reports overdue only from recorded run evidence older than a past start', () => {
    const now = Date.parse('2026-08-28T12:00:00.000Z');
    const daily = (overrides) => ({
      id: 'backup',
      name: 'Mongo backup',
      slots: [slot(Date.parse('2026-08-28T03:00:00.000Z'))],
      ...overrides
    });

    expect(upcoming.findOverdueEntries([daily({ lastRun: null })], { now })).toEqual([]);
    expect(upcoming.findOverdueEntries([daily({ lastRun: '2026-08-28T03:00:05.000Z' })], { now })).toEqual([]);
    expect(upcoming.findOverdueEntries([daily({ lastRun: '2026-08-27T03:00:05.000Z' })], { now })).toEqual([
      {
        id: 'backup',
        name: 'Mongo backup',
        expectedAt: '2026-08-28T03:00:00.000Z',
        lastRun: '2026-08-27T03:00:05.000Z'
      }
    ]);
    expect(upcoming.findOverdueEntries([daily({ lastRun: '2026-08-27T03:00:05.000Z' })], {
      now: Date.parse('2026-08-28T03:05:00.000Z')
    })).toEqual([]);
    expect(upcoming.findOverdueEntries([{
      id: 'watch',
      name: 'Ops watch',
      lastRun: '2026-08-20T00:00:00.000Z',
      slots: [{ start: '2026-08-28T00:00:00.000Z', end: '2026-08-29T00:00:00.000Z', continuous: true }]
    }], { now })).toEqual([]);
  });

  test('derives cadence from chronological starts even if slots arrive unsorted', () => {
    const base = Date.parse('2026-08-28T10:00:00.000Z');
    const entry = frequentEntry({ count: 0 });
    entry.slots = [slot(base + 10 * 60_000), slot(base), slot(base + 5 * 60_000)];
    expect(upcoming.deriveIntervalMs(entry, entry.slots[0])).toBe(5 * 60_000);
  });
});

describe('Cluster Schedule evidence presentation', () => {
  test('treats an all-null utilization grid as unobserved rather than zero percent', () => {
    const { context } = loadClusterScheduleContext();
    const container = { innerHTML: '' };
    const render = vm.runInContext('renderUtilHeatmap', context);
    const observed = render(container, {
      hosts: ['gpu-a'],
      days: ['2026-08-28'],
      grid: { 'gpu-a': [new Array(24).fill(null)] }
    });

    expect(observed).toBe(false);
    expect(container.innerHTML).toContain('No GPU usage measured');
    expect(container.innerHTML).toContain('unknown, not zero');
  });

  test('distinguishes observed zero utilization from hours without evidence', () => {
    const { context } = loadClusterScheduleContext();
    const container = { innerHTML: '' };
    const values = new Array(24).fill(null);
    values[4] = 0;
    const render = vm.runInContext('renderUtilHeatmap', context);
    const observed = render(container, {
      hosts: ['gpu-a'],
      days: ['2026-08-28'],
      grid: { 'gpu-a': [values] }
    });

    expect(observed).toBe(true);
    expect(container.innerHTML).toContain('04:00 — 0% utilization');
    expect(container.innerHTML).toContain('00:00 — not measured');
  });

  test('reads measured hours from the host identity keys returned by the API', () => {
    const { context } = loadClusterScheduleContext();
    const container = { innerHTML: '' };
    const values = new Array(24).fill(null);
    values[4] = 37;
    const render = vm.runInContext('renderUtilHeatmap', context);
    expect(render(container, {
      hosts: [{ key: 'primary', displayName: 'Host A' }],
      days: ['2026-08-28'],
      grid: { primary: [values] }
    })).toBe(true);
    expect(container.innerHTML).toContain('Host A');
    expect(container.innerHTML).toContain('04:00 — 37% utilization');
  });

  test('keeps countdown element ids attached to their tasks after section grouping', () => {
    const { context } = loadClusterScheduleContext();
    context.testTasks = [
      { name: 'Tick', source: 'agentx-system', taskType: 'monitoring',
        scheduleType: 'interval', intervalMs: 15 * 60_000, msFromNow: 60_000 },
      { name: 'Daily review', source: 'agentx-system', taskType: 'maintenance',
        scheduleType: 'cron', dailyCount: 1, msFromNow: 3_600_000 }
    ];
    vm.runInContext('nextTasksData = testTasks', context);
    const container = { innerHTML: '' };
    vm.runInContext('renderNextTasks', context)(container);
    expect(container.innerHTML).toMatch(/Daily review[\s\S]*countdown-1/);
    expect(container.innerHTML).toMatch(/Tick[\s\S]*countdown-0/);
  });

  test('uses an evidence-empty state for actual-vs-planned and retains measured zero', () => {
    const { context } = loadClusterScheduleContext();
    const render = vm.runInContext('renderActualVsPlanned', context);
    const emptyContainer = { innerHTML: '' };
    render(emptyContainer, { planned: [], actualByHost: { 'gpu-a': [] } });
    expect(emptyContainer.innerHTML).toContain('No GPU jobs assigned to a host and no measured usage');

    const measuredContainer = { innerHTML: '' };
    render(measuredContainer, {
      planned: [],
      actualByHost: {
        'gpu-a': [{ hour: 4, utilizationPct: 0, totalCalls: 1 }]
      }
    });
    expect(measuredContainer.innerHTML).toContain('gpu-a');
    expect(measuredContainer.innerHTML).toContain('04:00 actual 0% (1 call)');
  });

  test('draws a planned slot that ends at midnight to the end of the track', () => {
    const { context } = loadClusterScheduleContext();
    const container = { innerHTML: '' };
    const start = new Date(2026, 7, 28, 23, 0);
    const end = new Date(2026, 7, 29, 0, 0);
    vm.runInContext('renderActualVsPlanned', context)(container, {
      planned: [{ hostName: 'gpu-a', tasks: [{ name: 'Late job', model: 'm', taskType: 'benchmark',
        slots: [{ start: start.toISOString(), end: end.toISOString() }] }] }],
      actualByHost: {}
    });

    expect(container.innerHTML).toContain('left:95.83%;width:4.17%');
  });

  test('shows only declared assignments as host evidence in the legend', () => {
    const { context, elements } = loadClusterScheduleContext();
    const render = vm.runInContext('renderLegend', context);
    render([
      { name: 'Bound job', host: 'gpu-a', source: 'agentx' },
      { name: 'Shared job', host: null, source: 'agentx-system' },
      { name: 'Undeclared job', host: 'unassigned', source: 'agentx-system' }
    ]);
    const html = elements.get('legend').innerHTML;

    expect(html).toContain('Jobs per host');
    expect(html).toContain('gpu-a');
    expect(html).toContain('2 scheduled jobs have no assigned host.');
    expect(html).not.toContain('>No host assigned<');
  });

  test('lists each overflowing job set once with its window count, and no projection-only overdue', () => {
    const { context, elements } = loadClusterScheduleContext();
    context.testConflicts = Array.from({ length: 6 }, (_, index) => ({
      hostId: 'gpu-b',
      capacityVramMb: 24576,
      requiredVramMb: 26624,
      tasks: [
        { name: 'Voice model', resident: true },
        { name: index % 2 ? 'Doc re-embed' : 'RAG ingestion', resident: false },
        { name: index % 2 ? 'RAG ingestion' : 'Doc re-embed', resident: false }
      ]
    }));
    context.testHosts = [
      { id: 'gpu-a', name: 'GPU A', status: 'online' },
      { id: 'gpu-b', name: 'GPU B', status: 'unreachable' }
    ];
    vm.runInContext(`
      conflictsData = testConflicts;
      liveHostsData = testHosts;
      nextTasksData = [{ name: 'Running job', msFromNow: 0, running: true }];
      overdueData = [];
    `, context);
    vm.runInContext('renderAttention', context)();
    const html = elements.get('attentionList').innerHTML;

    expect(html.match(/VRAM overflow/g)).toHaveLength(1);
    expect(html).toContain('Doc re-embed + RAG ingestion with resident Voice model need 26.0 GB of 24.0 GB on GPU B (6 windows)');
    expect(html).toContain('GPU B unreachable');
    expect(html).not.toContain('GPU A unreachable');
    expect(html).not.toContain('overdue');
  });

  test('shows overdue entries with the expected time and last recorded run', () => {
    const { context, elements } = loadClusterScheduleContext();
    vm.runInContext(`
      conflictsData = [];
      liveHostsData = [];
      overdueData = [{ name: 'Mongo backup', expectedAt: '2026-08-28T03:00:00.000Z', lastRun: '2026-08-27T03:00:05.000Z' }];
    `, context);
    vm.runInContext('renderAttention', context)();
    const html = elements.get('attentionList').innerHTML;

    expect(html).toContain('Mongo backup overdue');
    expect(html).toContain('last recorded run');
  });

  test('follows midnight while watching today and leaves another selected day alone', () => {
    const { context } = loadClusterScheduleContext();
    let today = '2026-08-28';
    context.window.ClusterScheduleDate.localDateKey = () => today;
    context.window.ClusterScheduleDate.isToday = key => key === today;
    vm.runInContext('loadTimeline = () => { timelineReloads += 1; }; loadConflicts = () => {}; updateDateLabel = () => {}; var timelineReloads = 0;', context);
    const refresh = vm.runInContext('refreshTimelineClock', context);

    today = '2026-08-29';
    refresh();
    expect(vm.runInContext('currentDate', context)).toBe('2026-08-29');
    expect(vm.runInContext('timelineReloads', context)).toBe(1);

    vm.runInContext("currentDate = '2026-08-20'", context);
    refresh();
    expect(vm.runInContext('currentDate', context)).toBe('2026-08-20');
    expect(vm.runInContext('timelineReloads', context)).toBe(1);
  });

  test('loads the upcoming projection before the dashboard controller', () => {
    const app = read('src/app.js');
    const routeBlock = app.slice(
      app.indexOf("app.get('/cluster-schedule'"),
      app.indexOf("app.get('/memory-review'")
    );

    expect(routeBlock.indexOf('/js/cluster-schedule-upcoming.js'))
      .toBeLessThan(routeBlock.indexOf('/js/cluster-schedule.js'));
  });
});
