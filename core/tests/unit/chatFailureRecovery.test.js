'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { readChatMessagingSource } = require('../helpers/chatMessagingSource');

const source = readChatMessagingSource();
const outcomeSource = fs.readFileSync(path.join(__dirname, '../../public/js/chat/chat-turn-outcome.js'), 'utf8');

function loadFailureHelper() {
  const start = source.indexOf('function safeChatFailureMessage');
  const end = source.indexOf('\nexport async function sendMessageStreamFetch', start);
  if (start < 0 || end < 0) throw new Error('chatFailureDetails source not found');
  const helperSource = source.slice(start, end).replace(/export function/g, 'function');
  const context = {};
  vm.createContext(context);
  vm.runInContext(`${helperSource}\nthis.chatFailureDetails = chatFailureDetails;`, context);
  return context.chatFailureDetails;
}

describe('Playground failure recovery', () => {
  const chatFailureDetails = loadFailureHelper();

  test('points public-exposure failures to the secure portal', () => {
    expect(chatFailureDetails({ code: 'PUBLIC_EXPOSURE_GUARD', message: 'blocked' })).toEqual(expect.objectContaining({
      status: 'Secure portal required',
      guidance: expect.stringContaining('HTTPS portal')
    }));
  });

  test('gives a concrete timeout recovery path', () => {
    expect(chatFailureDetails({ message: 'Upstream timed out' })).toEqual(expect.objectContaining({
      status: 'Response timed out',
      tone: 'warning',
      guidance: expect.stringContaining('Quick mode')
    }));
  });

  test('reports a technical stream abort as interrupted rather than user-stopped', () => {
    expect(chatFailureDetails({
      code: 'STREAM_INTERRUPTED',
      message: 'The response stream was interrupted before completion.'
    })).toEqual(expect.objectContaining({
      status: 'Response interrupted',
      tone: 'warning',
      guidance: expect.stringContaining('Retry the turn')
    }));
  });

  test('redacts deployment endpoints and credentials from durable failure text', () => {
    const result = chatFailureDetails({
      message: 'fetch http://192.0.2.9:11434 failed token=super-secret'
    });
    expect(result.message).toContain('[service endpoint]');
    expect(result.message).toContain('[redacted credential]');
    expect(result.message).not.toContain('192.0.2.9');
    expect(result.message).not.toContain('super-secret');
  });

  test('an unsaved reply or a vanished conversation is reported, never shown as saved', () => {
    expect(chatFailureDetails({ code: 'CONVERSATION_NOT_FOUND', message: 'Conversation not found or archived.' }))
      .toEqual(expect.objectContaining({ status: 'Conversation unavailable', guidance: expect.stringContaining('Start a new chat') }));
    expect(chatFailureDetails({ code: 'CONVERSATION_PERSIST_FAILED', message: 'The reply could not be saved.' }))
      .toEqual(expect.objectContaining({ status: 'Reply not saved', tone: 'error' }));
  });

  test('persists stopped and failed outcomes instead of marking them ephemeral', () => {
    expect(outcomeSource).toContain("fetch('/api/history/turn-outcome'");
    expect(source).toContain("outcome: 'stopped'");
    expect(outcomeSource).toContain("outcome: 'failed'");
    expect(source).toContain('await recordFailedTurn(ctx, failure, {');
    expect(source).toContain('clientTurnId: terminalAttemptId');
    expect(source).not.toContain("{ persist: false, announcement: 'Response stopped.' }");
    expect(source).not.toContain("{ persist: false, announcement: 'Response failed. Review the status message.' }");
  });

  describe('failed turn for a conversation that no longer exists', () => {
    function loadOutcomeHelpers(fetchImpl) {
      const context = {
        fetch: jest.fn(fetchImpl),
        console: { error: jest.fn() },
        globalThis: {},
        document: {
          createElement: () => {
            const listeners = {};
            return {
              style: {},
              addEventListener: (event, fn) => { listeners[event] = fn; },
              click: () => listeners.click?.()
            };
          }
        }
      };
      vm.createContext(context);
      vm.runInContext(`${outcomeSource.replace(/export (async )?function/g, '$1function')}
        this.recordFailedTurn = recordFailedTurn;
        this.failedTurnMessage = failedTurnMessage;`, context);
      return context;
    }

    function makeCtx() {
      const feedback = { children: [], appendChild(child) { this.children.push(child); } };
      return {
        state: { conversationId: 'gone-conversation' },
        elements: { feedback },
        helpers: {
          setFeedback: jest.fn(),
          clearChat: jest.fn(),
          loadHistoryList: jest.fn(),
          loadConversation: jest.fn()
        }
      };
    }

    const gone = {
      code: 'CONVERSATION_NOT_FOUND',
      message: 'Conversation not found or archived. Start a new conversation.',
      tone: 'error'
    };

    test('skips the turn-outcome request and shows one message with a new-chat action', async () => {
      const outcome = loadOutcomeHelpers(async () => { throw new Error('must not be called'); });
      const ctx = makeCtx();

      await expect(outcome.recordFailedTurn(ctx, gone, { clientTurnId: 't-1', userMessage: 'Hi' })).resolves.toBe(false);

      expect(outcome.fetch).not.toHaveBeenCalled();
      expect(ctx.helpers.setFeedback).toHaveBeenCalledTimes(1);
      const [text, tone] = ctx.helpers.setFeedback.mock.calls[0];
      expect(tone).toBe('error');
      expect(text).toContain('no longer exists');
      expect(text).not.toMatch(/could not be saved|retry/i);
      expect(ctx.elements.feedback.children).toHaveLength(1);
      const [button] = ctx.elements.feedback.children;
      expect(button.textContent).toBe('Start a new chat');
      button.click();
      expect(ctx.helpers.clearChat).toHaveBeenCalledTimes(1);
    });

    test('does not offer a retry that the server would refuse again', () => {
      const outcome = loadOutcomeHelpers(async () => ({}));
      const record = outcome.failedTurnMessage(gone, 'failed', 'u-1');
      expect(record.retryUserMessageId).toBeNull();
      expect(record.metadata).toEqual(expect.objectContaining({ outcome: 'failed', retryable: false }));
      const other = outcome.failedTurnMessage({ code: 'STREAM_INTERRUPTED', message: 'x' }, 'failed', 'u-1');
      expect(other.retryUserMessageId).toBe('u-1');
      expect(other.metadata.retryable).toBe(true);
    });

    test('other failures are still recorded through the turn-outcome endpoint', async () => {
      const outcome = loadOutcomeHelpers(async () => ({
        ok: true,
        json: async () => ({ status: 'success', data: { conversationId: 'c-1' } })
      }));
      const ctx = makeCtx();
      const failure = { code: 'STREAM_INTERRUPTED', message: 'Interrupted.', tone: 'warning' };

      await expect(outcome.recordFailedTurn(ctx, failure, { clientTurnId: 't-2', userMessage: 'Hi' })).resolves.toBe(true);

      expect(outcome.fetch).toHaveBeenCalledWith('/api/history/turn-outcome', expect.anything());
      const body = JSON.parse(outcome.fetch.mock.calls[0][1].body);
      expect(body).toEqual(expect.objectContaining({ outcome: 'failed', errorCode: 'STREAM_INTERRUPTED' }));
      expect(ctx.helpers.setFeedback).toHaveBeenCalledWith('Interrupted. The failed turn was saved in history.', 'warning');
    });
  });
});
