'use strict';

jest.mock('../../config/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));

const mockFetch = jest.fn();
jest.mock('node-fetch', () => (...args) => mockFetch(...args));

const { searchWeb } = require('../../src/services/webSearch');

describe('searchWeb', () => {
  const saved = process.env.SEARXNG_URL;

  beforeEach(() => {
    mockFetch.mockReset();
    process.env.SEARXNG_URL = 'http://searxng.test:8088/';
  });

  afterAll(() => {
    if (saved === undefined) delete process.env.SEARXNG_URL; else process.env.SEARXNG_URL = saved;
  });

  it('lets SearXNG detect the query language by default', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ results: [{ title: 'Prix de l’essence', url: 'https://x.test', content: 'QC' }] }),
    });

    const result = await searchWeb('prix essence quebec');

    const url = new URL(mockFetch.mock.calls[0][0]);
    expect(url.origin + url.pathname).toBe('http://searxng.test:8088/search');
    expect(url.searchParams.get('language')).toBe('auto');
    expect(url.searchParams.get('format')).toBe('json');
    expect(result.error).toBeNull();
    expect(result.results).toEqual([{ title: 'Prix de l’essence', url: 'https://x.test', snippet: 'QC' }]);
  });

  it('keeps an explicit language', async () => {
    mockFetch.mockResolvedValue({ ok: true, json: async () => ({ results: [] }) });
    await searchWeb('weather', { language: 'fr-CA' });
    expect(new URL(mockFetch.mock.calls[0][0]).searchParams.get('language')).toBe('fr-CA');
  });

  it('reports a missing URL without calling the network', async () => {
    delete process.env.SEARXNG_URL;
    const result = await searchWeb('anything');
    expect(result.error).toBe('SEARXNG_URL is not configured');
    expect(mockFetch).not.toHaveBeenCalled();
  });
});
