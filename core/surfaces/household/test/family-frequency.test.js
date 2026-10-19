'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const window = {};
vm.runInNewContext(fs.readFileSync(require.resolve('../public/family-frequency'), 'utf8'), { window, Intl, Date });
const { label, kidLabel, options, fields, read } = window.FamilyFrequency;

function fakeForm(values) {
  return { querySelector: selector => ({ value: values[/name="(\w+)"/.exec(selector)[1]] }) };
}

test('frequency labels describe intervals and their winter variant', () => {
  assert.equal(label({ cadence: 'weekly' }), 'Every week');
  assert.equal(label({ cadence: 'interval', intervalDays: 10 }), 'Every 10 days');
  assert.equal(label({ cadence: 'interval', intervalDays: 7, winterIntervalDays: 14 }), 'Every 7 days (14 in winter)');
  assert.equal(label({ cadence: 'interval', intervalDays: 7, winterIntervalDays: 7 }), 'Every 7 days');
  assert.equal(kidLabel({ cadence: 'interval', intervalDays: 7, currentIntervalDays: 14 }), 'every 14 days');
  assert.equal(kidLabel({ cadence: 'daily' }), 'every day');
  assert.equal(kidLabel({ cadence: 'once' }), 'once');
});

test('the frequency select offers every N days and its fields stay bounded', () => {
  assert.match(options('interval'), /<option value="interval" selected>Every N days<\/option>/);
  assert.match(fields(), /name="intervalDays" type="number" min="2" max="90"/);
  assert.match(fields(), /name="winterIntervalDays"/);
});

test('only an interval frequency sends interval fields; an empty winter field clears it', () => {
  assert.deepEqual(JSON.parse(JSON.stringify(read(fakeForm({ intervalDays: '10', winterIntervalDays: '' }), 'interval'))), { intervalDays: 10, winterIntervalDays: null });
  assert.deepEqual(JSON.parse(JSON.stringify(read(fakeForm({ intervalDays: '7', winterIntervalDays: '14' }), 'interval'))), { intervalDays: 7, winterIntervalDays: 14 });
  assert.deepEqual(JSON.parse(JSON.stringify(read(fakeForm({ intervalDays: '7', winterIntervalDays: '14' }), 'weekly'))), {});
});
