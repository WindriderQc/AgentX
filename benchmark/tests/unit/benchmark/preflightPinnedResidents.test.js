'use strict';

jest.mock('../../../config/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock('../../../src/clients/coreApiClient', () => ({ getDedicationStatuses: jest.fn() }));

const { getDedicationStatuses } = require('../../../src/clients/coreApiClient');
const { checkPinnedResidents } = require('../../../src/services/benchmark/preflightPinnedResidents');

const EXEC = 'http://exec:11434';
const JUDGE = 'http://judge:11434';

describe('pre-flight pinned residents', () => {
    beforeEach(() => jest.clearAllMocks());

    it('warns that a separate judge host keeps its pinned models but refuses their calls during the batch', async () => {
        getDedicationStatuses.mockResolvedValue([
            { host: `${JUDGE}/`, pinnedModels: [{ model: 'bge-m3' }, { model: 'gemma4:12b' }] }
        ]);
        const result = await checkPinnedResidents([{ host: EXEC, model: 'candidate' }], { judgeHost: JUDGE });
        expect(result.ok).toBe(true);
        expect(result.affectedHosts).toEqual([]);
        expect(result.judgeHost).toEqual({ host: JUDGE, pinnedModels: ['bge-m3', 'gemma4:12b'] });
        expect(result.warnings).toEqual([
            expect.stringMatching(/^Judge host http:\/\/judge:11434 serves pinned model\(s\): bge-m3, gemma4:12b\. They stay loaded.*Core refuses their ordinary calls.*CPU host/)
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
