'use strict';

const { reservedSiblingEndpoints } = require('../../../src/services/profiler/reservedSiblings');

const ID = '74ceaeca-855d-4b17-ad70-183ab52ea341';
const GPU = 'http://192.0.2.10:11434';
const CPU = 'http://192.0.2.10:11435';
const OTHER_HOST = 'http://192.0.2.20:11434';
const list = (job) => async () => ({ jobs: [{ id: 'other', state: 'running', hosts: [GPU, CPU] }, job].filter(Boolean) });

describe('reserved sibling endpoints', () => {
  it('returns the same-machine endpoints its executing request covers', async () => {
    const job = { id: ID, state: 'running', hosts: [CPU, GPU, OTHER_HOST] };
    await expect(reservedSiblingEndpoints(ID, GPU, { list: list(job) })).resolves.toEqual([CPU]);
    await expect(reservedSiblingEndpoints(ID, GPU, { list: list({ ...job, state: 'dispatching' }) })).resolves.toEqual([CPU]);
  });

  it('returns none without an executing request that covers the lane itself', async () => {
    await expect(reservedSiblingEndpoints(null, GPU, { list: list(null) })).resolves.toEqual([]);
    await expect(reservedSiblingEndpoints(ID, GPU, { list: list(null) })).resolves.toEqual([]);
    await expect(reservedSiblingEndpoints(ID, GPU, { list: list({ id: ID, state: 'reserved', hosts: [GPU, CPU] }) })).resolves.toEqual([]);
    await expect(reservedSiblingEndpoints(ID, GPU, { list: list({ id: ID, state: 'running', hosts: [CPU] }) })).resolves.toEqual([]);
    await expect(reservedSiblingEndpoints(ID, GPU, { list: list({ id: ID, state: 'running', hosts: [GPU] }) })).resolves.toEqual([]);
  });

  it('never throws when Core cannot be read', async () => {
    await expect(reservedSiblingEndpoints(ID, GPU, { list: async () => { throw new Error('down'); } })).resolves.toEqual([]);
  });
});
