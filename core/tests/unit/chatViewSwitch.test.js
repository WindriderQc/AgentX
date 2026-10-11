'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.resolve(__dirname, '../..');
const historySource = fs.readFileSync(path.join(root, 'public/js/chat/chat-history.js'), 'utf8');
const messagingSource = fs.readFileSync(path.join(root, 'public/js/chat/chat-messaging.js'), 'utf8');

function loadDetach() {
  const body = historySource.match(/export function detachActiveReply[\s\S]*?\n}\n/)[0].replace('export ', '');
  const context = {};
  vm.createContext(context);
  vm.runInContext(`${body}\nthis.detachActiveReply = detachActiveReply;`, context);
  return context.detachActiveReply;
}

describe('switching the chat view during a reply', () => {
  test('detaches a streaming reply and frees the Send button', () => {
    const detach = loadDetach();
    const state = { viewEpoch: 2, streamAbortController: {}, streamStopRequestedController: null, sending: true };
    const elements = { sendBtn: { disabled: true, textContent: 'Stop' } };

    detach(state, elements);

    expect(state.viewEpoch).toBe(3);
    expect(state.streamAbortController).toBeNull();
    expect(state.sending).toBe(false);
    expect(elements.sendBtn).toEqual({ disabled: false, textContent: 'Send' });
  });

  test('only bumps the view when nothing is in flight', () => {
    const detach = loadDetach();
    const state = { streamAbortController: null, sending: false };
    const elements = { sendBtn: { disabled: false, textContent: 'Send and load' } };

    detach(state, elements);

    expect(state.viewEpoch).toBe(1);
    expect(elements.sendBtn.textContent).toBe('Send and load');
  });

  test('a detached reply does not write into the new view', () => {
    expect(historySource).toContain('if (id !== state.conversationId) detachActiveReply(state, elements);');
    expect(messagingSource).toContain('if (viewChanged()) { doneReceived = true; helpers.loadHistoryList(); return; }');
    expect(messagingSource).toContain("if (viewChanged()) { console.error('Detached reply failed:', err); return; }");
    expect(messagingSource).toContain('if (viewChanged()) { helpers.loadHistoryList(); return; }');
  });
});
