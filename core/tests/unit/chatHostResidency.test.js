'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

// Run the browser module's actual exports without its browser-only imports.
const source = fs.readFileSync(path.resolve(__dirname, '../../public/js/chat/chat-config.js'), 'utf8')
  .replace(/^import .*;$/gm, '').replace(/^export /gm, '');
const context = {};
vm.runInNewContext(`${source}\nthis.readResidents = getHostRunningModels;`, context);
const read = context.readResidents;
const saved = { loadedModel: 'saved-resident', loadedModels: ['saved-resident', 'saved-embedding'] };

test.each([undefined, {}, { runningModels: [] }, { online: false, runningModels: [] },
  { observation: { status: 'unavailable' }, runningModels: [{ name: 'old-observation' }] },
  { observation: { status: 'stale' }, runningModels: [{ name: 'old-observation' }] }
])('absent, empty or unusable live observation cannot resurrect persisted models: %j', live => {
  expect(read({ ...saved, live })).toEqual([]);
});

test('current observations, including legacy live shapes, stay readable', () => {
  expect(read({ ...saved, live: { online: true, observation: { status: 'fresh' },
    runningModels: [{ name: 'current-resident' }, { model: 'current-embedding' }] } }))
    .toEqual(['current-resident', 'current-embedding']);
  expect(read({ ...saved, live: { runningModels: [{ name: 'legacy-live-resident' }] } }))
    .toEqual(['legacy-live-resident']);
});
