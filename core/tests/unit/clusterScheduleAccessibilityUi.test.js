const fs = require('fs');
const path = require('path');
const vm = require('vm');
const projection = require('../../public/js/cluster-schedule-upcoming');

const read = name => fs.readFileSync(path.join(__dirname, '../../', name), 'utf8');

function element(dataset = {}) {
  const attributes = {};
  const classes = new Set();
  const listeners = {};
  return {
    dataset, attributes, listeners, innerHTML: '', style: {},
    offsetWidth: 300, offsetHeight: 180,
    setAttribute: (key, value) => { attributes[key] = value; },
    removeAttribute: key => { delete attributes[key]; },
    addEventListener: (key, value) => { listeners[key] = value; },
    getBoundingClientRect: () => ({ left: 100, top: 200, bottom: 228 }),
    querySelectorAll: () => [], querySelector: () => null,
    focus: jest.fn(),
    classList: {
      add: name => classes.add(name), remove: name => classes.delete(name),
      contains: name => classes.has(name),
      toggle: (name, on) => on ? classes.add(name) : classes.delete(name)
    }
  };
}

function setup() {
  const elements = new Map();
  const listeners = {};
  const document = {
    activeElement: null,
    addEventListener: (key, fn) => { listeners[key] = fn; },
    getElementById: id => {
      if (!elements.has(id)) elements.set(id, element());
      return elements.get(id);
    },
    querySelector: () => element(), querySelectorAll: () => []
  };
  const context = vm.createContext({
    window: {
      ClusterScheduleUpcoming: projection,
      ClusterScheduleDate: {
        browserTimeZone: () => 'UTC', localDateKey: () => '2026-08-28', isToday: () => false
      },
      AgentXUtils: { escapeHtml: value => String(value ?? '').replaceAll('"', '&quot;') },
      addEventListener: jest.fn(), innerWidth: 1440, innerHeight: 900
    },
    document, fetch: jest.fn()
  });
  for (const name of ['cluster-schedule', 'cluster-schedule-services', 'cluster-schedule-actual']) {
    vm.runInContext(read(`public/js/${name}.js`), context);
  }
  return { context, document, elements, listeners, run: code => vm.runInContext(code, context) };
}

test('slots expose name, time and host, and open on focus, tap and keyboard activation', () => {
  const { run, document, listeners } = setup();
  const markup = run('getSlotSegments')([
    { start: '2026-08-28T10:00:00Z', end: '2026-08-28T10:30:00Z' }
  ], 0, 24, 'sync', 'Example job', false, { host: 'gpu-a' });
  expect(markup).toContain('tabindex="0" role="button"');
  expect(markup).toMatch(/aria-label="Example job, .*gpu-a"/);

  const slot = element({ ttName: 'Example job', ttTime: '10:00–10:30', ttHost: 'gpu-a' });
  run('attachTooltipEvents')({ querySelectorAll: () => [slot] });
  const tooltip = document.getElementById('tooltip');
  const trigger = type => slot.listeners[type]({ type, currentTarget: slot, target: {} });
  trigger('focus');
  expect(tooltip.classList.contains('visible')).toBe(true);
  expect(tooltip.attributes['aria-hidden']).toBe('false');
  expect(slot.attributes['aria-describedby']).toBe('tooltip');
  expect(tooltip.style.left).toBe('100px');
  expect(tooltip.style.top).toBe('238px');
  document.activeElement = slot;
  trigger('mouseleave');
  expect(tooltip.classList.contains('visible')).toBe(true);
  listeners.keydown({ key: 'Escape' });
  expect(tooltip.classList.contains('visible')).toBe(false);
  expect(slot.attributes['aria-describedby']).toBeUndefined();
  trigger('click');
  expect(tooltip.classList.contains('visible')).toBe(true);
  trigger('blur');
  expect(tooltip.classList.contains('visible')).toBe(false);
  const preventDefault = jest.fn();
  slot.listeners.keydown({ key: ' ', preventDefault, currentTarget: slot });
  expect(preventDefault).toHaveBeenCalled();
  expect(tooltip.classList.contains('visible')).toBe(true);
});

test('service chips open on focus and tap, stay on pointer leave while focused, and close on blur or Escape', () => {
  const { run, document, listeners } = setup();
  run(`persistentServicesData = [{ id: 'watch', name: 'Example watch', taskType: 'monitoring',
    host: 'gpu-a', scheduleType: 'continuous', slots: [{ continuous: true }] }]`);
  run('renderServicesStrip')(run('persistentServicesData'));
  expect(document.getElementById('servicesGrid').innerHTML).toContain('tabindex="0" role="button"');
  expect(document.getElementById('servicesGrid').innerHTML).toContain('aria-label="Example watch, 24/7, gpu-a"');
  const chip = element({ serviceId: 'watch' });
  document.querySelectorAll = () => [chip];
  run('attachServiceChipEvents')();
  const popover = document.getElementById('servicePopover');
  chip.listeners.focus({ currentTarget: chip });
  expect(popover.classList.contains('visible')).toBe(true);
  expect(chip.attributes['aria-expanded']).toBe('true');
  document.activeElement = chip;
  chip.listeners.mouseleave({ currentTarget: chip });
  expect(popover.classList.contains('visible')).toBe(true);
  listeners.keydown({ key: 'Escape' });
  expect(popover.classList.contains('visible')).toBe(false);
  chip.listeners.click({ currentTarget: chip });
  expect(popover.innerHTML).toContain('Pinned');
  chip.listeners.blur({ relatedTarget: null });
  expect(popover.classList.contains('visible')).toBe(false);
  expect(chip.attributes['aria-expanded']).toBe('false');
});

test('group collapse renders loaded data without a request and restores header focus', () => {
  const { run, document, context } = setup();
  const header = element({ groupKey: 'sync' });
  document.activeElement = header;
  document.getElementById('heatmapContainer').querySelectorAll = selector => selector === '.cs-group-header' ? [header] : [];
  run(`visibleTimelineEntries = [{ name: 'Example job', taskType: 'sync', slots: [] }]`);
  run('toggleGroup')('sync');
  expect(context.fetch).not.toHaveBeenCalled();
  expect(document.getElementById('heatmapContainer').innerHTML).toContain('aria-expanded="false"');
  expect(header.focus).toHaveBeenCalled();
  run('toggleGroup')('sync');
  expect(document.getElementById('heatmapContainer').innerHTML).toContain('aria-expanded="true"');
});

test('toggle states expose initial and updated selections', () => {
  const { run, document } = setup();
  const view = read('views/pages/cluster-schedule.ejs');
  expect(view).toMatch(/id="viewTask"[^>]+aria-pressed="true"/);
  expect(view).toMatch(/id="viewHost"[^>]+aria-pressed="false"/);
  expect(view).toMatch(/id="btnHeatmap"[^>]+aria-pressed="true"/);
  expect(view).toMatch(/id="btnAvp"[^>]+aria-pressed="false"/);
  run('loadTimeline = () => {}; loadConflicts = () => {}; loadActualVsPlanned = () => {};');
  run('setViewMode')('host');
  expect(document.getElementById('viewHost').attributes['aria-pressed']).toBe('true');
  expect(document.getElementById('viewTask').attributes['aria-pressed']).toBe('false');
  run('setActualView')('avp');
  expect(document.getElementById('btnAvp').attributes['aria-pressed']).toBe('true');
  expect(document.getElementById('btnHeatmap').attributes['aria-pressed']).toBe('false');
  run('toggleServices')();
  expect(document.getElementById('servicesToggle').attributes['aria-expanded']).toBe('false');
  run('toggleServices')();
  expect(document.getElementById('servicesToggle').attributes['aria-expanded']).toBe('true');
});
