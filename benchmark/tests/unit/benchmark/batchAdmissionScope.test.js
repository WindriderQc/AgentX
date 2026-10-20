'use strict';
jest.mock('../../../config/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
const { batchAdmissionScope, resolveBatchAdmissionScope } = require('../../../src/services/benchmark/batchAdmissionScope');

describe('batch admission scope', () => {
    const targets = [{ executionKind: 'ollama', host: 'http://exec:11434' }];
    const judge = { host: 'http://judge:11434', model: 'judge-27b' };
    const pins = entries => ({ hostPins: new Map([['http://judge:11434', entries]]) });
    test('shares a separate local judge host whose pin is the judge, without changing the workload kind', () => {
        expect(batchAdmissionScope(targets, judge, pins(['judge-27b', 'bge-m3']))).toEqual({
            kind: 'benchmark', hosts: ['http://exec:11434', 'http://judge:11434'], sharedHosts: ['http://judge:11434']
        });
        expect(batchAdmissionScope(targets, judge, pins([])).sharedHosts).toEqual(['http://judge:11434']);
    });
    test('reserves a separate judge host whose pin is another model, or whose pins are unknown (#901)', () => {
        expect(batchAdmissionScope(targets, judge, pins(['resident-27b', 'bge-m3']))).toEqual({
            kind: 'benchmark', hosts: ['http://exec:11434', 'http://judge:11434'], sharedHosts: []
        });
        expect(batchAdmissionScope(targets, judge).sharedHosts).toEqual([]);
    });
    test('reads the pins only for a separate judge host, and reserves it when Core cannot say', async () => {
        const getDedicationStatuses = jest.fn(async () => [{ host: 'http://judge:11434/', pinnedModels: [{ model: 'judge-27b' }] }]);
        await expect(resolveBatchAdmissionScope(targets, judge, { getDedicationStatuses }))
            .resolves.toMatchObject({ sharedHosts: ['http://judge:11434'] });
        await expect(resolveBatchAdmissionScope(targets, {}, { getDedicationStatuses }))
            .resolves.toMatchObject({ sharedHosts: [] });
        expect(getDedicationStatuses).toHaveBeenCalledTimes(1);
        const unreachable = jest.fn(async () => { throw new Error('core unreachable'); });
        await expect(resolveBatchAdmissionScope(targets, judge, { getDedicationStatuses: unreachable }))
            .resolves.toMatchObject({ hosts: ['http://exec:11434', 'http://judge:11434'], sharedHosts: [] });
    });
    test('deduplicates co-located candidates and their default judge', () => {
        expect(batchAdmissionScope([...targets, ...targets])).toEqual({
            kind: 'benchmark', hosts: ['http://exec:11434'], sharedHosts: []
        });
    });
    test('includes a local judge for harness-only candidates', () => {
        expect(batchAdmissionScope([{ executionKind: 'harness', host: null }], judge, pins(['judge-27b'])))
            .toEqual({ kind: 'benchmark-cloud', hosts: ['http://judge:11434'], sharedHosts: ['http://judge:11434'] });
    });
    test('a harness judge changes kind without claiming its pseudo-host as Ollama', () => {
        expect(batchAdmissionScope(targets, {
            host: 'harness:test', target: { executionKind: 'harness' }
        })).toEqual({ kind: 'benchmark-cloud', hosts: ['http://exec:11434'], sharedHosts: [] });
    });
});
