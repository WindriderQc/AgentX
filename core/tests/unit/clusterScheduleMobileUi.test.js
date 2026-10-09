const fs = require('fs');
const path = require('path');
const vm = require('vm');
const projection = require('../../public/js/cluster-schedule-upcoming');

const now = Date.parse('2026-08-28T12:00:00Z');
const slot = (start, end) => ({ start: new Date(start).toISOString(), end: new Date(end).toISOString() });

test('mobile projection sorts all remaining occurrences, includes running slots and excludes finished or invalid slots', () => {
  const entries = [
    { name: 'Later', slots: [slot(now + 3600_000, now + 3660_000)] },
    { name: 'Finished', slots: [slot(now - 120_000, now - 60_000)] },
    { name: 'Running', slots: [slot(now - 60_000, now + 60_000)] },
    { name: 'Recurring', slots: [slot(now + 120_000, now + 180_000), slot(now + 60_000, now + 120_000)] },
    { name: 'Invalid', slots: [{ start: 'invalid', end: 'invalid' }, slot(now + 60_000, now)] }
  ];
  const remaining = projection.buildRemainingTimelineSlots(entries, now);
  expect(remaining.map(item => item.entry.name)).toEqual(['Running', 'Recurring', 'Recurring', 'Later']);
  expect(projection.buildRemainingTimelineSlots(entries, now + 86400_000)).toEqual([]);
  expect(projection.buildRemainingTimelineSlots(entries, now - 86400_000)).toHaveLength(5);
});

function setup(width = 390) {
  const elements = new Map();
  const events = {};
  const context = vm.createContext({
    window: {
      innerWidth: width, innerHeight: 844,
      ClusterScheduleUpcoming: projection,
      ClusterScheduleDate: {
        browserTimeZone: () => 'UTC', localDateKey: () => '2099-08-28', isToday: () => false
      },
      AgentXUtils: { escapeHtml: value => String(value ?? '').replaceAll('"', '&quot;').replaceAll('<', '&lt;') },
      addEventListener: (key, listener) => { events[key] = listener; }
    },
    document: {
      addEventListener: jest.fn(),
      getElementById: id => {
        if (!elements.has(id)) elements.set(id, {
          innerHTML: '', setAttribute: jest.fn(), classList: { remove: jest.fn() },
          querySelectorAll: () => []
        });
        return elements.get(id);
      }
    },
    fetch: jest.fn()
  });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../../public/js/cluster-schedule.js'), 'utf8'), context);
  return { context, events, elements, run: code => vm.runInContext(code, context) };
}

const futureEntries = [{
  name: 'Example job with a long descriptive label', taskType: 'sync', host: 'gpu-a',
  slots: [slot(Date.parse('2099-08-28T23:15:00Z'), Date.parse('2099-08-28T23:16:00Z'))]
}];

test('mobile task and host views show time, name, host and type with accessible details instead of the grid', () => {
  const { run } = setup();
  const container = { innerHTML: '', querySelectorAll: () => [] };
  run('renderGroupedHeatmap')(container, futureEntries);
  expect(container.innerHTML).toContain('<ol class="cs-mobile-timeline">');
  expect(container.innerHTML).not.toContain('cs-heatmap-grid');
  expect(container.innerHTML).toContain('datetime="2099-08-28T23:15:00.000Z"');
  expect(container.innerHTML).toContain('Example job with a long descriptive label');
  expect(container.innerHTML).toContain('gpu-a');
  expect(container.innerHTML).toContain('cs-task-badge sync');
  expect(container.innerHTML).toContain('tabindex="0" role="button"');
  run('renderHostHeatmap')(container, [{ hostId: 'gpu-b', tasks: [{ ...futureEntries[0], host: null }] }]);
  expect(container.innerHTML).toContain('gpu-b');
  expect(container.innerHTML).not.toContain('cs-heatmap-grid');
});

test('changing viewport size re-renders loaded timeline data without a request', () => {
  const { context, run, events, elements } = setup(1440);
  context.entries = futureEntries;
  run("visibleTimelineEntries = entries; renderedTimelineMode = 'task';");
  context.window.innerWidth = 390;
  events.resize();
  expect(elements.get('heatmapContainer').innerHTML).toContain('cs-mobile-timeline');
  context.window.innerWidth = 1440;
  events.resize();
  expect(elements.get('heatmapContainer').innerHTML).toContain('cs-heatmap-grid');
  expect(context.fetch).not.toHaveBeenCalled();
});

test('desktop task and host labels retain full titles', () => {
  const { run } = setup(1440);
  const container = { innerHTML: '', querySelectorAll: () => [] };
  run('renderGroupedHeatmap')(container, futureEntries);
  expect(container.innerHTML).toContain('title="Example job with a long descriptive label');
  run('renderHostHeatmap')(container, [{ hostId: 'gpu-a', hostName: 'Long host display name', tasks: [] }]);
  expect(container.innerHTML).toContain('title="Long host display name"');
});
