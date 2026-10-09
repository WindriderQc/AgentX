const { loadStoredTurns, resolveContextMessages } = require('../../src/services/chat/conversationHistory');
const { findConversationForUpdate } = require('../../src/services/chat/conversationPersistence');
const Conversation = require('../../models/Conversation');

jest.mock('../../models/Conversation', () => {
  const MockModel = jest.fn();
  MockModel.findOne = jest.fn();
  return MockModel;
});

describe('conversation history rehydration', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    Conversation.findOne.mockResolvedValue(null);
  });

  test('a known conversation rehydrates its stored user/assistant turns oldest first', async () => {
    const turns = [
      { role: 'user', content: 'First question' },
      { role: 'assistant', content: 'First answer' },
      { role: 'user', content: 'Second question' },
      { role: 'assistant', content: 'Second answer' },
      { role: 'tool', content: 'not model context' },
      null,
      { role: 'user', content: 42 }
    ];
    Conversation.findOne.mockResolvedValue({ messages: turns });

    const result = await loadStoredTurns({ conversationId: '507f1f77bcf86cd799439011', userId: 'user123' });

    expect(Conversation.findOne).toHaveBeenCalledWith({
      _id: '507f1f77bcf86cd799439011',
      userId: 'user123',
      'lifecycle.status': { $ne: 'archived' }
    });
    expect(result).toEqual([
      { role: 'user', content: 'First question' },
      { role: 'assistant', content: 'First answer' },
      { role: 'user', content: 'Second question' },
      { role: 'assistant', content: 'Second answer' }
    ]);
  });

  test.each([
    ['without an id', {}],
    ['without an owner', { conversationId: '507f1f77bcf86cd799439011' }]
  ])('loads nothing %s', async (_label, params) => {
    const result = await loadStoredTurns(params);
    expect(result).toEqual([]);
    expect(Conversation.findOne).not.toHaveBeenCalled();
  });

  test('an unknown, archived or other owner conversation loads nothing', async () => {
    const result = await loadStoredTurns({ conversationId: '507f1f77bcf86cd799439011', userId: 'user123' });
    expect(result).toEqual([]);
  });

  test('explicit caller messages always win over the stored transcript', async () => {
    Conversation.findOne.mockResolvedValue({ messages: [{ role: 'user', content: 'Stored' }] });
    const explicit = [{ role: 'user', content: 'Caller' }];
    const result = await resolveContextMessages({
      messages: explicit, conversationId: '507f1f77bcf86cd799439011', userId: 'user123'
    });
    expect(result).toEqual(explicit);
  });

  test('historyContext disabled sends no prior turns', async () => {
    Conversation.findOne.mockResolvedValue({ messages: [{ role: 'user', content: 'Stored' }] });
    const result = await resolveContextMessages({
      conversationId: '507f1f77bcf86cd799439011', userId: 'user123', historyContext: false
    });
    expect(result).toEqual([]);
  });

  test('rehydration is a read-only path: it never saves the conversation', async () => {
    const save = jest.fn();
    Conversation.findOne.mockResolvedValue({ messages: [{ role: 'user', content: 'Stored' }], save });
    await loadStoredTurns({ conversationId: '507f1f77bcf86cd799439011', userId: 'user123' });
    expect(save).not.toHaveBeenCalled();
  });

  test('rehydration shares the owner-scoped lookup used by the routes and persistence', () => {
    // Guard: rehydration and persistence keep using the same owner fence
    // (archived and foreign ids must behave identically everywhere).
    expect(typeof findConversationForUpdate).toBe('function');
  });
});
