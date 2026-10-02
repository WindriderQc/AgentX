'use strict';

const mockGetActive = jest.fn();
const mockFindOne = jest.fn().mockResolvedValue({ name: 'default_chat', version: 1 });

jest.mock('../../models/PromptConfig', () => {
  const MockPromptConfig = jest.fn();
  MockPromptConfig.getActive = (...args) => mockGetActive(...args);
  MockPromptConfig.findOne = (...args) => mockFindOne(...args);
  return MockPromptConfig;
});
jest.mock('../../config/logger', () => ({ warn: jest.fn() }));

const { getActivePrompt, buildSystemPrompt } = require('../../src/services/chat/chatPromptHelpers');

describe('chatPromptHelpers', () => {
  beforeEach(() => jest.clearAllMocks());

  test('uses an explicit authoritative system prompt without consulting stored personas', async () => {
    const prompt = await getActivePrompt('Nestor local system.', 'default_chat', {
      preferSystem: true
    });

    expect(prompt).toEqual({
      systemPrompt: 'Nestor local system.',
      version: 'request-override',
      name: 'default_chat',
      _id: null
    });
    expect(mockGetActive).not.toHaveBeenCalled();
  });

  test('preserves stored prompt precedence for ordinary chat callers', async () => {
    mockGetActive.mockResolvedValue({
      systemPrompt: 'Stored prompt.',
      version: 3,
      name: 'default_chat',
      _id: 'prompt-3'
    });

    const prompt = await getActivePrompt('Request prompt.', 'default_chat');

    expect(prompt.systemPrompt).toBe('Stored prompt.');
    expect(mockGetActive).toHaveBeenCalledWith('default_chat');
  });

  test('resolves an exact stored version without requiring activation or random selection', async () => {
    mockFindOne.mockResolvedValueOnce({
      systemPrompt: 'Draft prompt.',
      version: 4,
      name: 'reviewer',
      isActive: false,
      _id: 'prompt-4'
    });

    const prompt = await getActivePrompt('', 'reviewer', { promptVersion: '4' });

    expect(prompt).toMatchObject({ name: 'reviewer', version: 4, isActive: false });
    expect(mockFindOne).toHaveBeenCalledWith({ name: 'reviewer', version: 4 });
    expect(mockGetActive).not.toHaveBeenCalled();
  });

  test('rejects invalid or missing exact versions instead of silently substituting', async () => {
    await expect(getActivePrompt('', 'reviewer', { promptVersion: 'bad' })).rejects.toMatchObject({
      code: 'INVALID_PROMPT_VERSION',
      statusCode: 400
    });

    mockFindOne.mockResolvedValueOnce(null);
    await expect(getActivePrompt('', 'reviewer', { promptVersion: 99 })).rejects.toMatchObject({
      code: 'PROMPT_VERSION_UNAVAILABLE',
      statusCode: 404
    });
    expect(mockGetActive).not.toHaveBeenCalled();
  });

  test('adds the stored profile fields to the system prompt', () => {
    const prompt = buildSystemPrompt('Base.', {
      about: 'Engineer.',
      preferences: { customInstructions: 'Be brief.', language: 'Français', role: 'Operator', style: 'Concise.' }
    }, null);

    expect(prompt).toBe([
      'Base.',
      'User Profile/Memory:\nEngineer.',
      'Custom Instructions:\nBe brief.',
      'Preferred Language: Français',
      'User Role / Context: Operator',
      'Response Style:\nConcise.'
    ].join('\n\n'));
  });

  test('leaves the base prompt unchanged for an empty profile', () => {
    expect(buildSystemPrompt('Base.', { about: '', preferences: { language: '', role: '', style: '' } }, null)).toBe('Base.');
    expect(buildSystemPrompt('Base.', {}, null)).toBe('Base.');
  });
});
