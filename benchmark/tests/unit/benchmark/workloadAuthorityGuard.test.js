'use strict';

const mongoose = require('mongoose');
const mongoOptions = require('../../../../shared/testing/mongoOptions');
const { MongoMemoryServer } = require('mongodb-memory-server');

jest.mock('../../../src/clients/coreApiClient', () => ({ getWorkloadRecoveryIdentity: jest.fn() }));

const { getWorkloadRecoveryIdentity } = require('../../../src/clients/coreApiClient');
const BenchmarkAuthorityReconciliation = require('../../../models/BenchmarkAuthorityReconciliation');
const guard = require('../../../src/services/benchmark/workloadAuthorityGuard');

const WORKLOAD = 'judge-batch:batch-1';

function admission(id) {
    return {
        recoveryId: `recovery-${id}`,
        recoveryRequestId: `recovery:${WORKLOAD}`,
        admissionId: `admission-${id}`,
        generation: `generation-${id}`,
        principal: 'benchmark-service'
    };
}

async function completeRun(id) {
    getWorkloadRecoveryIdentity.mockReturnValue(admission(id));
    await guard.prepareWorkloadAuthority({ workloadId: WORKLOAD, batchId: 'batch-1', phase: 'judge' });
    await guard.verifyWorkloadAuthority(WORKLOAD, { run: id });
    return guard.resolveWorkloadAuthority(WORKLOAD, { released: true, run: id });
}

let mongoServer;

beforeAll(async () => {
    mongoServer = await MongoMemoryServer.create();
    await mongoose.connect(mongoServer.getUri(), mongoOptions);
});

afterAll(async () => {
    await mongoose.disconnect();
    await mongoServer.stop();
});

afterEach(async () => {
    await BenchmarkAuthorityReconciliation.deleteMany({});
});

describe('workload authority guard', () => {
    test('a second run of the same workload id completes after the first one resolved', async () => {
        await completeRun('a');
        const second = await completeRun('b');

        expect(second).toMatchObject({ state: 'resolved', admissionId: 'admission-b', releaseReceipt: { run: 'b' } });
        expect(await BenchmarkAuthorityReconciliation.countDocuments({ resultId: `workload:${WORKLOAD}` })).toBe(1);
    });

    test('a guard still pending for an earlier admission is not taken over', async () => {
        getWorkloadRecoveryIdentity.mockReturnValue(admission('a'));
        await guard.prepareWorkloadAuthority({ workloadId: WORKLOAD, phase: 'judge' });

        getWorkloadRecoveryIdentity.mockReturnValue(admission('b'));
        const guardRecord = await guard.prepareWorkloadAuthority({ workloadId: WORKLOAD, phase: 'judge' });

        expect(guardRecord).toMatchObject({ state: 'pending_reconciliation', admissionId: 'admission-a' });
    });

    test('preparing twice for the same admission keeps one pending guard', async () => {
        getWorkloadRecoveryIdentity.mockReturnValue(admission('a'));
        await guard.prepareWorkloadAuthority({ workloadId: WORKLOAD, phase: 'judge' });
        const again = await guard.prepareWorkloadAuthority({ workloadId: WORKLOAD, phase: 'judge' });

        expect(again).toMatchObject({ state: 'pending_reconciliation', admissionId: 'admission-a' });
        await expect(guard.verifyWorkloadAuthority(WORKLOAD)).resolves.toMatchObject({ state: 'verified' });
    });
});
