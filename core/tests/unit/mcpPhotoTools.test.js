'use strict';

const { handleMcpMessage } = require('../../src/services/mcpSkillBus');

function call(name, args, photoService) {
  return handleMcpMessage({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }, { photoService });
}

function fakeService() {
  return {
    smartSearch: jest.fn(async (query) => ({ ranked: true, query })),
    metadataSearch: jest.fn(async (query) => ({ exact: true, query })),
    count: jest.fn(async () => ({ total: 4, exact: true })),
    asset: jest.fn(async (id, query) => ({ id, query })),
    people: jest.fn(async () => ({ count: 1, people: [{ id: 'p', name: 'Alice Example' }] })),
    places: jest.fn(async () => ({ cities: ['Sampleton'], states: [], countries: [] })),
    tags: jest.fn(async (query) => ({ count: 0, tags: [], query })),
  };
}

describe('photo tools on the Core MCP bus', () => {
  test('are listed on the default profile only', async () => {
    const listed = await handleMcpMessage({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
    expect(listed.result.tools.map((tool) => tool.name)).toEqual(expect.arrayContaining(['photo_search', 'photo_count', 'photo_details', 'photo_names']));
    const memory = await handleMcpMessage({ jsonrpc: '2.0', id: 1, method: 'tools/list' }, {}, { profile: 'memory' });
    expect(memory.result.tools.map((tool) => tool.name)).not.toContain('photo_search');
  });

  test('a query selects the words-based search, no query the exact search', async () => {
    const service = fakeService();
    const smart = await call('photo_search', { query: 'à la plage', person: 'Alice', limit: 5, audience: 'family' }, service);
    expect(smart.result.isError).toBe(false);
    expect(service.smartSearch).toHaveBeenCalledWith({ q: 'à la plage', person: 'Alice', limit: '5', audience: 'family' });
    await call('photo_search', { city: 'Sampleton', order: 'asc' }, service);
    expect(service.metadataSearch).toHaveBeenCalledWith({ city: 'Sampleton', order: 'asc' });
  });

  test('count, details and names reach the photo service', async () => {
    const service = fakeService();
    expect((await call('photo_count', { year: '2025' }, service)).result.structuredContent).toEqual({ total: 4, exact: true });
    await call('photo_details', { id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', audience: 'family' }, service);
    expect(service.asset).toHaveBeenCalledWith('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', { audience: 'family' });
    await call('photo_names', { kind: 'places' }, service);
    await call('photo_names', { kind: 'tags', audience: 'family' }, service);
    expect(service.places).toHaveBeenCalled();
    expect(service.tags).toHaveBeenCalledWith({ audience: 'family' });
  });

  test('a refused name comes back as a tool error that names the candidates', async () => {
    const service = fakeService();
    service.metadataSearch.mockRejectedValue(Object.assign(new Error('"Jo" matches several named persons; ask which one'),
      { code: 'PHOTOS_PERSON_AMBIGUOUS', status: 409, details: { candidates: ['Jo Example', 'Jo Sample'] } }));
    const response = await call('photo_search', { person: 'Jo' }, service);
    expect(response.result.isError).toBe(true);
    expect(response.result.structuredContent).toEqual({ error: 'PHOTOS_PERSON_AMBIGUOUS',
      message: '"Jo" matches several named persons; ask which one. Candidates: Jo Example, Jo Sample' });
  });
});
