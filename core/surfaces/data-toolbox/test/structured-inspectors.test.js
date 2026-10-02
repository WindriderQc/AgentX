'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const app = fs.readFileSync(path.resolve(__dirname, '..', 'public', 'app.js'), 'utf8');

test('Databases inspect renders a bounded structured table, not raw JSON by default', () => {
  assert.doesNotMatch(app, /<pre id="documentJson" class="json">/);
  assert.match(app, /const INSPECT_LIMIT = 20;/);
  assert.match(app, /documents\?limit=\$\{INSPECT_LIMIT\}/);
  assert.match(app, /function documentColumns\(docs, hintedFields\)/);
  assert.match(app, /function fieldTypes\(docs\)/);
  assert.match(app, /Fields and types in this preview/);
  assert.match(app, /data-inspector-search/);
  assert.match(app, /data-sort-key=/);
  assert.match(app, /<details class="expert"><summary>JSON<\/summary><pre class="json">/);
  assert.match(app, /This browser cannot modify, delete, or export documents\./);
});

test('collection freshness is derived from timestamps or ObjectId, never assumed', () => {
  assert.match(app, /function newestTimestamp\(docs\)/);
  assert.match(app, /newest record \(no timestamp observed\)/);
  assert.match(app, /parseInt\(id\.slice\(0, 8\), 16\) \* 1000/);
});

test('Live Data inspect shows readable timestamps, ages and feed-specific fields, with JSON as expert disclosure', () => {
  assert.doesNotMatch(app, /<pre id="feedJson" class="json">/);
  assert.match(app, /const FEED_COLUMNS = Object\.freeze\(\{\s*iss: \['latitude', 'longitude'/);
  assert.match(app, /<th>Observed<\/th><th>Age<\/th>/);
  assert.match(app, /function ageLabel\(value\)/);
  assert.match(app, /timestamp field/);
  assert.match(app, /Map rendering is intentionally omitted from this read-only console\./);
});

test('the inspectors stay read-only and bounded', () => {
  for (const forbidden of ['DELETE', 'method: \'PUT\'', 'method: \'PATCH\'', '/export']) {
    assert.ok(!app.includes(`fetch(\`/databases${forbidden}`), `unexpected ${forbidden}`);
  }
  assert.doesNotMatch(app, /databases\/collections\/[^`]*\/(delete|drop|export)/);
});
