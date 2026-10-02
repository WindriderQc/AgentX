'use strict';

const { shouldSyncRegisteredHosts } = require('../../src/helpers/benchmarkProfileCapabilities');

describe('Benchmark profile capabilities', () => {
  it('keeps registered-host sync out of the demo product', () => {
    expect(shouldSyncRegisteredHosts('demo')).toBe(false);
    expect(shouldSyncRegisteredHosts(undefined)).toBe(false);
  });

  it('syncs registered hosts in the explicit full profile', () => {
    expect(shouldSyncRegisteredHosts('full')).toBe(true);
    expect(shouldSyncRegisteredHosts(' FULL ')).toBe(true);
  });
});
