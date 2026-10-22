'use strict';

// #897: the budget Core keeps must be the WorkerEnvelope the cell runs under.

jest.mock('../../src/clients/coreHttp', () => ({ coreRequest: jest.fn() }));

const { coreRequest } = require('../../src/clients/coreHttp');
const { CORE_OPERATIONS } = require('../../src/clients/coreOperations');
const { closeCellBudget, openCellBudget } = require('../../src/clients/coreCellBudgets');

const BUDGET_ID = 'a'.repeat(32);
const envelope = { fingerprint: 'e'.repeat(64), budgets: { maxTurns: 20, maxToolCalls: 40, maxTokens: 500000, maxDurationMs: 600000 } };
const claim = { host: 'http://primary:11434', claimBatchId: 'batch', claimGeneration: 'claim', workloadAdmissionId: 'admission',
  workloadGeneration: 'generation', budgetId: 'ignored' };
const input = { cellId: 'cell', envelope, targetFingerprint: 't'.repeat(64), claims: [claim], ttlMs: 900000 };
const record = (overrides = {}) => ({ data: { budgetId: BUDGET_ID, envelopeFingerprint: envelope.fingerprint, targetFingerprint: 't'.repeat(64),
  maxTurns: 20, maxToolCalls: 40, maxTokens: 500000, ...overrides } });

beforeEach(() => coreRequest.mockReset());

test('opens with the envelope ceilings and exact claim proof only', async () => {
  coreRequest.mockResolvedValueOnce(record());
  await expect(openCellBudget(input)).resolves.toMatchObject({ budgetId: BUDGET_ID });
  const [path, options] = coreRequest.mock.calls[0];
  expect(path).toBe('/api/nerve-center/benchmark-cell-budgets');
  expect(options.operationId).toBe(CORE_OPERATIONS.CELL_BUDGET_OPEN);
  const body = JSON.parse(options.body);
  expect(body).toMatchObject({ cellId: 'cell', envelopeFingerprint: envelope.fingerprint, maxTurns: 20, maxToolCalls: 40, maxTokens: 500000 });
  expect(body.claims).toEqual([{ host: claim.host, claimBatchId: 'batch', claimGeneration: 'claim', workloadAdmissionId: 'admission', workloadGeneration: 'generation' }]);
});

test.each([
  ['another envelope', { envelopeFingerprint: 'f'.repeat(64) }],
  ['another ceiling', { maxTurns: 21 }],
  ['an invalid id', { budgetId: 'forged' }],
])('refuses a Core record with %s', async (_name, overrides) => {
  coreRequest.mockResolvedValueOnce(record(overrides));
  await expect(openCellBudget(input)).rejects.toMatchObject({ code: 'CORE_CELL_BUDGET_MISMATCH' });
});

test('an unreachable Core or unreadable counts are explicit failures', async () => {
  coreRequest.mockRejectedValueOnce(new Error('down'));
  await expect(openCellBudget(input)).rejects.toMatchObject({ code: 'CORE_CELL_BUDGET_UNAVAILABLE' });
  coreRequest.mockResolvedValueOnce({ data: { budgetId: BUDGET_ID } });
  await expect(closeCellBudget(BUDGET_ID)).rejects.toMatchObject({ code: 'CORE_CELL_BUDGET_UNREADABLE' });
  await expect(closeCellBudget('forged')).rejects.toMatchObject({ code: 'CORE_CELL_BUDGET_INVALID' });
  coreRequest.mockResolvedValueOnce({ data: { budgetId: BUDGET_ID, turns: 4 } });
  await expect(closeCellBudget(BUDGET_ID)).resolves.toMatchObject({ turns: 4 });
  expect(coreRequest.mock.calls.at(-1)[1].operationId).toBe(CORE_OPERATIONS.CELL_BUDGET_CLOSE);
});
