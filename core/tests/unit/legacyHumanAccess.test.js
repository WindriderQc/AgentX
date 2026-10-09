'use strict';
const { safeDestination } = require('../../src/middleware/legacyHumanAccess');
const env = { CORE_PUBLIC_URL: 'https://home.example', BENCHMARK_PUBLIC_URL: 'https://home.example:3081' };

test.each([
  undefined, [' /dad'], '//evil.example/x', '/\\evil.example/x', 'https://evil.example/',
  'http://home.example/', 'javascript:alert(1)', 'https://owner:secret@home.example/',
  '/unlock', '/UNLOCK?next=/dad', '/access/face', '/api/access/unlock', '/api/psyx/auth/status',
  '/%75nlock', '/%2f%2fevil.example', '/%5cevil.example', '/%0d%0aLocation:evil', '/bad%zz',
  '/dad\r\nLocation:evil', '/unlock/nested', '/x/../unlock', '/x'.repeat(1000)
])('refuses unsafe or recursive legacy destinations: %p', next => {
  expect(safeDestination(next, env)).toBe('/dad');
});

test('preserves safe paths and exact configured service origins', () => {
  expect(safeDestination('/panel?profile=synthetic', env)).toBe('/panel?profile=synthetic');
  expect(safeDestination('https://home.example:3081/leaderboard?tab=judges', env))
    .toBe('https://home.example:3081/leaderboard?tab=judges');
});
