const mongoose = require('mongoose');
const Conversation = require('../../models/Conversation');

describe('Conversation Model', () => {
  it('should be invalid if required fields are missing', () => {
    const conversation = new Conversation();

    const validationError = conversation.validateSync();
    // ConversationSchema has no required top-level field (userId defaults to
    // 'default', model and systemPrompt are optional strings), so an empty
    // Conversation validates. The required fields live on MessageSchema
    // (role, content), which is what this test exercises.
    const message = conversation.messages.create({}); // Empty message
    conversation.messages.push(message);

    const error = conversation.validateSync();
    expect(error).toBeDefined();
    expect(error.errors['messages.0.role']).toBeDefined();
    expect(error.errors['messages.0.content']).toBeDefined();
  });

  it('should validate valid conversation', () => {
    const conversation = new Conversation({
      userId: 'test_user',
      model: 'llama2',
      messages: []
    });

    const validationError = conversation.validateSync();
    expect(validationError).toBeUndefined();
  });

  it('should set default values', () => {
    const conversation = new Conversation({
      userId: 'test_user',
      model: 'llama2'
    });

    expect(conversation.messages).toEqual([]);
    expect(conversation.ragRequested).toBe(false);
    expect(conversation.ragUsed).toBe(false);
  });
});
