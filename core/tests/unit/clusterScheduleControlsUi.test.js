const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.resolve(__dirname, '../..');
const read = relative => fs.readFileSync(path.join(root, relative), 'utf8');

test('the schedule controls work without CSP-blocked inline handlers', () => {
  const view = read('views/pages/cluster-schedule.ejs');
  const dashboard = read('public/js/cluster-schedule.js');
  const app = read('src/app.js');
  expect(view).not.toMatch(/\bon(?:click|change)=/i);
  expect(dashboard).not.toMatch(/\bon(?:click|change)=/i);
  expect(app).toContain('/js/cluster-schedule-controls.js');

  const elements = new Map();
  const callbacks = {};
  const calls = [];
  const document = {
    addEventListener: (name, callback) => { callbacks[name] = callback; },
    getElementById: id => {
      if (!elements.has(id)) {
        const listeners = {};
        elements.set(id, {
          listeners,
          addEventListener: (name, callback) => { listeners[name] = callback; }
        });
      }
      return elements.get(id);
    }
  };
  const context = vm.createContext({
    document,
    shiftDate: value => calls.push(['date', value]),
    goToday: () => calls.push(['today']),
    setViewMode: value => calls.push(['view', value]),
    refreshAll: () => calls.push(['refresh']),
    toggleServices: () => calls.push(['services']),
    setTimelineFilter: (name, value) => calls.push(['filter', name, value]),
    setActualView: value => calls.push(['actual', value]),
    actualViewChanged: () => calls.push(['days']),
    toggleGroup: value => calls.push(['group', value])
  });
  vm.runInContext(read('public/js/cluster-schedule-controls.js'), context);
  callbacks.DOMContentLoaded();
  elements.get('viewHost').listeners.click();
  elements.get('viewTask').listeners.click();
  elements.get('btnAvp').listeners.click();
  elements.get('btnHeatmap').listeners.click();
  elements.get('prevDateBtn').listeners.click();
  elements.get('nextDateBtn').listeners.click();
  elements.get('heatmapDays').listeners.change();
  elements.get('heatmapContainer').listeners.click({
    target: { closest: () => ({ dataset: { groupKey: 'inference' } }) }
  });
  expect(calls).toEqual([
    ['view', 'host'], ['view', 'task'], ['actual', 'avp'], ['actual', 'heatmap'],
    ['date', -1], ['date', 1], ['days'], ['group', 'inference']
  ]);
});
