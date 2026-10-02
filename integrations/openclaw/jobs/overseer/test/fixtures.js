'use strict';

const REPORT = [
  '# Overseer report',
  '## Stale claims',
  'None.',
  '## Conflicts and duplication',
  'None.',
  '## Architecture drift',
  'None.',
  '## Automation health',
  'All synthetic jobs healthy.',
  '## Recommended next actions',
  '- Nothing to do.',
].join('\n');

const SNAPSHOT_TEXT = JSON.stringify({
  mode: 'full',
  schemaVersion: 5,
  generatedAt: '2026-01-01T00:00:00.000Z',
  readOnly: true,
  authority: 'aio-ops-runtime-bridges',
  status: 'ok',
  lead: { held_by: null },
});

function transcriptMessages({ report = REPORT, extraCall } = {}) {
  const messages = [
    { role: 'user', content: [{ type: 'text', text: 'Run the holistic review.' }] },
    {
      role: 'assistant',
      content: [{ type: 'toolCall', id: 'call-read', name: 'read', arguments: { path: 'workspace/BOOTSTRAP.md' } }],
    },
    {
      role: 'toolResult', toolCallId: 'call-read', toolName: 'read', isError: false,
      content: [{ type: 'text', text: 'Synthetic bootstrap.' }],
    },
    {
      role: 'assistant',
      content: [{
        type: 'toolCall', id: 'call-snapshot', name: 'agentx__ecosystem_snapshot',
        arguments: { mode: 'full', maxChars: 60000 },
      }],
    },
    {
      role: 'toolResult', toolCallId: 'call-snapshot', toolName: 'agentx__ecosystem_snapshot', isError: false,
      content: [{ type: 'text', text: SNAPSHOT_TEXT }],
    },
  ];
  if (extraCall) {
    messages.push(
      { role: 'assistant', content: [{ type: 'toolCall', id: 'call-extra', name: extraCall, arguments: {} }] },
      { role: 'toolResult', toolCallId: 'call-extra', toolName: extraCall, isError: false, content: [] },
    );
  }
  messages.push({ role: 'assistant', content: [{ type: 'text', text: report }] });
  return messages;
}

function transcriptJsonl(options) {
  return `${transcriptMessages(options).map((message) => JSON.stringify({ type: 'message', message })).join('\n')}\n`;
}

module.exports = { REPORT, SNAPSHOT_TEXT, transcriptJsonl, transcriptMessages };
