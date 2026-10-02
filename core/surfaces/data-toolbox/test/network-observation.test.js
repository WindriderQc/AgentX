'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const app = fs.readFileSync(path.resolve(__dirname, '..', 'public', 'app.js'), 'utf8');

test('Network counts "online now" from Data observation semantics, never from the raw flag', () => {
  assert.doesNotMatch(app, /item\.status === 'online' \|\| item\.online === true\)\.length\), 'currently online'/);
  assert.match(app, /const summary = devicesBody\.summary && typeof devicesBody\.summary === 'object' \? devicesBody\.summary : null;/);
  assert.match(app, /metric\(onlineNow, 'online now'\)/);
  assert.match(app, /Reference time \$\{date\(summary\.referenceTime\)\} · online = seen within/);
  assert.match(app, /"online now" is not observed/);
  assert.match(app, /OBSERVATION_LABELS = Object\.freeze\(\{\s*online: 'online now',\s*recent: 'recently seen',\s*historical: 'historical',\s*never_confirmed: 'never confirmed'/);
  assert.match(app, /observationPill\(device\.observation\)/);
});

test('the overview uses the same Data summary as the Network tab', () => {
  assert.match(app, /networkSummary \? number\(networkSummary\.online\) : '—'/);
  assert.match(app, /online now \(not observed\)/);
});

test('historical observations stay listed with their reporting collector', () => {
  assert.match(app, /<th>Observation<\/th><th>Reported by<\/th><th>Last seen<\/th>/);
  assert.match(app, /device\.observation\?\.source \|\| device\.scanSource \|\| '—'/);
});
