'use strict';
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '../..');

test('served Household and PsyX documents expose direct navigation and usable conversation controls', () => {
  const household = fs.readFileSync(path.join(root, 'surfaces/household/public/index.html'), 'utf8');
  expect(household).toContain('product-navigation');
  const psyx = fs.readFileSync(path.join(root, 'surfaces/psyx/public/index.html'), 'utf8');
  expect(psyx).toContain('id="composer"');
  expect(psyx).toContain('id="sessionsToggle"');
  for (const document of [household, psyx]) expect(document).not.toMatch(/access-assets|unlockForm|privacyGate|psyx-locked|data-access|lockPsyx/);
  const client = fs.readFileSync(path.join(root, 'surfaces/psyx/public/app.js'), 'utf8');
  for (const name of fs.readdirSync(path.join(root, 'surfaces/psyx/public')).filter(name => name.endsWith('.js'))) {
    expect(fs.readFileSync(path.join(root, 'surfaces/psyx/public', name), 'utf8')).not.toMatch(/api\/access|api\/psyx\/auth|showGate|accessEpoch|state\.unlocked|PSYX_LOCKED/);
  }
});
