jest.mock('../../utils/fetch-utils', () => ({
  fetchWithTimeoutAndRetry: jest.fn()
}));

jest.mock('../../utils/logger', () => ({
  log: jest.fn()
}));

const { buildPrompt, parseAIResponse, ACTIONS } = require('../../services/janitorAI');

describe('ACTIONS', () => {
  test('defines all four action types', () => {
    expect(ACTIONS).toEqual(
      expect.objectContaining({
        triage: expect.any(Object),
        resolve_duplicates: expect.any(Object),
        analyze_path: expect.any(Object),
        chat: expect.any(Object)
      })
    );
  });

  test('each action has a system prompt string', () => {
    for (const [key, action] of Object.entries(ACTIONS)) {
      expect(typeof action.system).toBe('string');
      expect(action.system.length).toBeGreaterThan(20);
    }
  });
});

describe('buildPrompt', () => {
  test('returns model, system, and prompt fields', () => {
    const result = buildPrompt('chat', { message: 'hello' });
    expect(result).toHaveProperty('taskType', 'janitor_ai');
    expect(result).toHaveProperty('system');
    expect(result).toHaveProperty('prompt');
    expect(result.prompt).toContain('hello');
  });

  test('triage action includes file context in prompt', () => {
    const context = {
      files: [{ path: '/mnt/datalake/a.txt', size: 100 }],
      stats: { totalFiles: 1 }
    };
    const result = buildPrompt('triage', context);
    expect(result.prompt).toContain('/mnt/datalake/a.txt');
    expect(result.system).toContain('KEEP');
  });

  test('triage tells the model which actions and file entries were omitted', () => {
    const coverage = { actions: { included: 50, available: 70 }, fileEntries: { included: 250, available: 700 } };
    const result = buildPrompt('triage', { files: [], coverage });
    expect(result.prompt).toContain(JSON.stringify(coverage));
    expect(result.prompt).toContain('Unsampled actions and files have not been reviewed');
  });

  test('resolve_duplicates includes duplicate paths', () => {
    const context = {
      duplicates: [
        { path: '/mnt/datalake/a.txt', mtime: '2024-01-01' },
        { path: '/mnt/datalake/b.txt', mtime: '2025-01-01' }
      ]
    };
    const result = buildPrompt('resolve_duplicates', context);
    expect(result.prompt).toContain('/mnt/datalake/a.txt');
    expect(result.prompt).toContain('/mnt/datalake/b.txt');
  });

  test('throws on unknown action', () => {
    expect(() => buildPrompt('unknown', {})).toThrow(/Unknown action/);
  });
});

describe('parseAIResponse', () => {
  test('extracts JSON from markdown code fence', () => {
    const raw = 'Here is my analysis:\n```json\n{"categories":[]}\n```\nDone.';
    const result = parseAIResponse(raw);
    expect(result).toEqual({ categories: [] });
  });

  test('extracts plain JSON object', () => {
    const raw = '{"keep":"/a.txt","delete":["/b.txt"],"reason":"older"}';
    const result = parseAIResponse(raw);
    expect(result).toEqual({ keep: '/a.txt', delete: ['/b.txt'], reason: 'older' });
  });

  test('returns raw text when no JSON found', () => {
    const raw = 'I recommend keeping all files.';
    const result = parseAIResponse(raw);
    expect(result).toEqual({ text: raw });
  });
});

describe('requestLimits', () => {
  const { requestLimits } = require('../../services/janitorAI');

  it('keeps the GPU default: one minute and one retry', () => {
    expect(requestLimits({})).toEqual({ timeout: 60000, retries: 1 });
    expect(requestLimits({ JANITOR_AI_TIMEOUT_MS: 'abc' })).toEqual({ timeout: 60000, retries: 1 });
  });

  it('lets a slow CPU host answer, without queueing a retry behind a long request', () => {
    expect(requestLimits({ JANITOR_AI_TIMEOUT_MS: '600000' })).toEqual({ timeout: 600000, retries: 0 });
    expect(requestLimits({ JANITOR_AI_TIMEOUT_MS: '120000' })).toEqual({ timeout: 120000, retries: 1 });
  });

  it('bounds the configured value', () => {
    expect(requestLimits({ JANITOR_AI_TIMEOUT_MS: '5' }).timeout).toBe(10000);
    expect(requestLimits({ JANITOR_AI_TIMEOUT_MS: '99999999' }).timeout).toBe(1200000);
  });
});
