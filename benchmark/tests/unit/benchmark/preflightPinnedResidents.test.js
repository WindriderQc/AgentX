'use strict';

jest.mock('../../../config/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock('../../../src/clients/coreApiClient', () => ({ getDedicationStatuses: jest.fn() }));

const { getDedicationStatuses } = require('../../../src/clients/coreApiClient');
const { checkPinnedResidents } = require('../../../src/services/benchmark/preflightPinnedResidents');

const EXEC = 'http://exec:11434';
const JUDGE = 'http://judge:11434';

describe('pre-flight pinned residents', () => {
    beforeEach(() => jest.clearAllMocks());

    it('says that a separate judge host whose pin is the judge is shared', async () => {
        getDedicationStatuses.mockResolvedValue([
            { host: `${JUDGE}/`, pinnedModels: [{ model: 'gemma4:12b' }, { model: 'bge-m3' }] }
        ]);
        const result = await checkPinnedResidents([{ host: EXEC, model: 'candidate' }],
            { judgeHost: JUDGE, judgeModel: 'gemma4:12b' });
        expect(result.ok).toBe(true);
        expect(result.affectedHosts).toEqual([]);
        expect(result.judgeHost).toEqual({ host: JUDGE, pinnedModels: ['gemma4:12b', 'bge-m3'], replacesPin: false });
        expect(result.warnings).toEqual([
            expect.stringMatching(/^Judge host http:\/\/judge:11434 has the judge gemma4:12b as its pin\. The batch shares the host/)
        ]);
    });

    it('says that a judge that is not the pin replaces it for the batch', async () => {
        getDedicationStatuses.mockResolvedValue([
            { host: JUDGE, pinnedModels: [{ model: 'resident-27b' }, { model: 'bge-m3' }] }
        ]);
        const result = await checkPinnedResidents([{ host: EXEC, model: 'candidate' }],
            { judgeHost: JUDGE, judgeModel: 'judge-27b' });
        expect(result.judgeHost).toEqual({ host: JUDGE, pinnedModels: ['resident-27b', 'bge-m3'], replacesPin: true });
        expect(result.warnings).toEqual([
            expect.stringMatching(/^The judge judge-27b replaces the pin on http:\/\/judge:11434 \(resident-27b, bge-m3\) for this batch\..*the pin returns when the batch ends/)
        ]);
    });

    it('keeps the execution host notice and does not repeat it for a judge on that host', async () => {
        getDedicationStatuses.mockResolvedValue([{ host: EXEC, pinnedModels: ['resident-model'], state: 'dedicated' }]);
        const result = await checkPinnedResidents([{ host: EXEC, model: 'candidate' }], { judgeHost: EXEC });
        expect(result.affectedHosts).toEqual([{
            host: EXEC, pinnedModels: ['resident-model'], nonPinnedBatchModels: ['candidate'], state: 'dedicated'
        }]);
        expect(result.judgeHost).toBeNull();
        expect(result.warnings).toEqual([expect.stringMatching(/temporarily unloaded during the batch/)]);
    });

    it('says nothing without pinned models, a judge host, or a reachable Core', async () => {
        getDedicationStatuses.mockResolvedValue([{ host: JUDGE, pinnedModels: [] }]);
        expect((await checkPinnedResidents([{ host: EXEC, model: 'candidate' }], { judgeHost: JUDGE })).warnings).toEqual([]);
        getDedicationStatuses.mockResolvedValue([{ host: JUDGE, pinnedModels: ['bge-m3'] }]);
        expect((await checkPinnedResidents([{ host: EXEC, model: 'candidate' }])).warnings).toEqual([]);
        getDedicationStatuses.mockRejectedValue(new Error('core unreachable'));
        expect(await checkPinnedResidents([{ host: EXEC, model: 'candidate' }], { judgeHost: JUDGE }))
            .toEqual({ ok: true, affectedHosts: [], judgeHost: null, warnings: [] });
    });
});
