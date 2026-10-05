'use strict';
const { loadConfig } = require('../../surfaces/psyx/src/config');
const { createAuth } = require('../../surfaces/psyx/src/auth');

test('PsyX defaults to human LAN access without a secret or expiring sessions', () => {
  const config = loadConfig({});
  expect(config.accessMode).toBe('trusted-network');
  expect(config.sessionTtlMs).toBeUndefined();
  const next = jest.fn(); const res = { locals: {} };
  createAuth(config).requireAccess({ get: () => undefined }, res, next);
  expect(next).toHaveBeenCalledTimes(1);
  expect(res.locals.psyxUserId).toBe('default');
});

test('native-only embedding token mode fails closed with absent or invalid credentials', () => {
  const native = createAuth({ accessMode: 'token', accessToken: 'synthetic-native' });
  for (const authorization of [undefined, 'Bearer incorrect']) {
    const next = jest.fn(); const res = { status: jest.fn().mockReturnThis(), json: jest.fn(), locals: {} };
    native.requireAccess({ get: () => authorization }, res, next);
    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(401);
  }
});
