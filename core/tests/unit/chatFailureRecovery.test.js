'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const source = fs.readFileSync(path.join(__dirname, '../../public/js/chat/chat-messaging.js'), 'utf8');
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
    expect(source).toContain("outcome: 'failed'");
    expect(source).toContain('clientTurnId: terminalAttemptId');
    expect(source).not.toContain("{ persist: false, announcement: 'Response stopped.' }");
    expect(source).not.toContain("{ persist: false, announcement: 'Response failed. Review the status message.' }");
  });
});
