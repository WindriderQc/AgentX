'use strict';
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '../..');

test('served Household document exposes direct navigation and its application mount', () => {
  const household = fs.readFileSync(path.join(root, 'surfaces/household/public/index.html'), 'utf8');
  expect(household).toContain('product-navigation');
  expect(household).toContain('<main id="app"');
  expect(household).not.toMatch(/access-assets|unlockForm|privacyGate|data-access/);
});
