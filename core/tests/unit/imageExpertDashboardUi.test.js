'use strict';
const { officialDashboardUrl } = require('../../src/services/images/expertDashboard');

test('official management link preserves a proxy prefix and selects only imageX', () => {
  expect(officialDashboardUrl({ HERMES_PUBLIC_URL: 'https://workshop.example/hermes?token=excluded#old',
    HERMES_DASHBOARD_URL: 'http://127.0.0.1:9119' })).toBe('https://workshop.example/hermes/?profile=imagex');
  expect(officialDashboardUrl({ HERMES_DASHBOARD_URL: 'http://127.0.0.1:9119/' })).toBe('http://127.0.0.1:9119/?profile=imagex');
});

test.each([undefined, 'invalid', 'javascript:alert(1)', 'https://user:secret@workshop.example/'])
('unconfigured, unsafe or credential-bearing management URL is omitted: %s', value => {
  expect(officialDashboardUrl({ HERMES_PUBLIC_URL: value })).toBeNull();
});
