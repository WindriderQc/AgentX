'use strict';
const fs = require('fs');
const path = require('path');
const root = path.resolve(__dirname, '../..');
const view = fs.readFileSync(path.join(root, 'views/pages/operations-jobs.ejs'), 'utf8');
const script = fs.readFileSync(path.join(root, 'public/js/operations-jobs.js'), 'utf8');
const {productSpaces} = require('../../../shared/productSpaces');
const {demoSurfaceDisabled} = require('../../../shared/agentxRuntimeProfile');

test('the operations destination is reachable from shared navigation and confined to the full profile', () => {
  const links = productSpaces((_service, route) => route).flatMap(group => group.children);
  expect(links.some(link => link.href === '/automations')).toBe(true);
  expect(demoSurfaceDisabled('/automations')).toBe(true);
  expect(demoSurfaceDisabled('/api/automations')).toBe(true);
  expect(demoSurfaceDisabled('/operations-jobs')).toBe(true);
  expect(demoSurfaceDisabled('/api/operations/jobs')).toBe(true);
});
test('settings and inventory have explicit keyboard and screen-reader contracts', () => {
  expect(view).toContain('role="tablist"');
  expect(view).toContain('aria-labelledby="settingsTitle"');
  expect(view).toContain('role="status"');
  expect(script).toContain("'ArrowLeft', 'ArrowRight', 'Home', 'End'");
  expect(script).toContain('editRevision = state.snapshot.revision');
});
test('browser execution preserves an unresolved request identity across refresh', () => {
  expect(script.indexOf('savePending();\n        await api')).toBeGreaterThan(-1);
  expect(script).toContain('state.pending[identifier] || crypto.randomUUID()');
  expect(script).toContain("new Set(['accepted', 'running', 'unknown', 'waiting-host'])");
});
