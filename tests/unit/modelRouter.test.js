/**
 * Unit tests for modelRouter failover logic
 */
jest.mock('node-fetch', () => jest.fn());
jest.mock('../../src/services/alertService', () => ({
    getAlertService: () => ({
        triggerAlert: jest.fn().mockResolvedValue({})
    })
}));
jest.mock('../../models/RemediationAction', () => ({
    RemediationAction: {
        create: jest.fn().mockResolvedValue({})
    }
}));

const fetch = require('node-fetch');
const { classifyAndRoute, getModelHealth } = require('../../src/services/modelRouter');
const { RemediationAction } = require('../../models/RemediationAction');
const { getAlertService } = require('../../src/services/alertService');

describe('ModelRouter failover logic', () => {
    const primaryHost = 'http://primary-host:11434';
    const secondaryHost = 'http://secondary-host:11434';
    let dateSpy;

    beforeAll(() => {
        process.env.OLLAMA_HOST = primaryHost;
        process.env.OLLAMA_HOST_SECONDARY = secondaryHost;
    });

    beforeEach(() => {
        jest.clearAllMocks();
        dateSpy = jest.spyOn(Date, 'now');
    });

    afterEach(() => {
        dateSpy.mockRestore();
    });

    test('routes to primary when healthy', async () => {
        dateSpy.mockImplementation(() => 1000);
        fetch.mockImplementation(() => Promise.resolve({ ok: true }));

        const result = await classifyAndRoute('hello', { taskType: 'quick_chat' });

        expect(result.failedOver).toBe(false);
        expect(result.host).toBe(primaryHost);
        expect(fetch).toHaveBeenCalledTimes(1);
    });

    test('fails over when primary slow and logs remediation + alert', async () => {
        const timestamps = [0, 6001, 6001, 7000, 7010, 7010]; // primary start/end/lastChecked + backup
        dateSpy.mockImplementation(() => timestamps.shift() || 8000);

        fetch.mockImplementation((url) => {
            if (url.startsWith(primaryHost)) {
                return Promise.resolve({ ok: true });
            }
            if (url.startsWith(secondaryHost)) {
                return Promise.resolve({ ok: true });
            }
            return Promise.resolve({ ok: true });
        });

        const result = await classifyAndRoute('need code', { taskType: 'quick_chat' });

        expect(result.failedOver).toBe(true);
        expect(result.host).toBe(secondaryHost);
        expect(RemediationAction.create).toHaveBeenCalledWith(expect.objectContaining({
            strategy: 'model_failover',
            automatedExecution: true
        }));
        expect(getAlertService().triggerAlert).toHaveBeenCalledWith(
            'model_failover',
            'warning',
            expect.objectContaining({
                backup: secondaryHost
            })
        );
    });

    test('health cache avoids redundant checks within TTL', async () => {
        const timestamps = [0, 100, 100, 1100, 1100, 1200, 1200];
        dateSpy.mockImplementation(() => timestamps.shift() || 1300);

        fetch.mockResolvedValue({ ok: true });

        const health1 = await getModelHealth(primaryHost, 'qwen2.5:7b');
        const health2 = await getModelHealth(primaryHost, 'qwen2.5:7b');

        expect(health1).toEqual(health2);
        expect(fetch).toHaveBeenCalledTimes(1);
    });
});
