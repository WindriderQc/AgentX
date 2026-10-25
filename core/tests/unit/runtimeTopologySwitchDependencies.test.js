'use strict';

// The switch service is tested with fakes; this checks that the real modules
// it uses by default expose every function it calls. A missing export broke
// the first live switch (2026-10-25).
const CONTRACT = {
  '../../src/services/hostPreferenceService': ['getAll', 'getByHost', 'getPinnedEntries', 'hasActiveBenchmarkClaim', 'restorePinnedModels'],
  '../../src/services/hostPinPrimitives': ['verifyPinnedEntriesLoaded'],
  '../../src/services/runtimeCoordinationService': ['acquireMaintenance', 'heartbeat', 'listActive', 'markMaintenanceUnknown',
    'release', 'recoverMaintenanceAfterOperatorReconciliation'],
  '../../src/services/hostSessionHoldService': ['isHostHeld'],
  '../../src/services/runtimePhysicalResources': ['resourcesFor', 'resourceTopology'],
  '../../src/services/laneObservabilityService': ['observeTopologySwitchFailure'],
  '../../src/services/runtimeTopologyService': ['describeTopology', 'parseTopology'],
  '../../src/services/runtimeTopologyParking': [],
  '../../src/services/runtimeTopologyActuator': ['createActuatorClient']
};

it('every default dependency of the switch exposes the functions it calls', () => {
  const missing = [];
  for (const [path, names] of Object.entries(CONTRACT)) {
    const mod = require(path);
    for (const name of names) if (typeof mod[name] !== 'function') missing.push(`${path}#${name}`);
  }
  const parking = require('../../src/services/runtimeTopologyParking').defaultParking;
  for (const name of ['beginSwitch', 'endSwitch', 'setIntendedMode', 'switchInProgress', 'intendedMode']) {
    if (typeof parking[name] !== 'function') missing.push(`defaultParking#${name}`);
  }
  const client = require('../../src/services/runtimeTopologyActuator').createActuatorClient({ readRaw: () => '' });
  for (const name of ['status', 'activate', 'confirm', 'rollback', 'configured', 'configurationError']) {
    if (typeof client[name] !== 'function') missing.push(`actuatorClient#${name}`);
  }
  expect(missing).toEqual([]);
});

it('the default switch service builds from the real modules', () => {
  const { createTopologySwitchService } = require('../../src/services/runtimeTopologySwitchService');
  expect(typeof createTopologySwitchService().recoverUncertain).toBe('function');
});
