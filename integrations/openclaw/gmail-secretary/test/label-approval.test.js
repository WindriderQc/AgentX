import test from 'node:test';
import assert from 'node:assert/strict';
import { approvalFor, buildOrganizeCommand, createPlugin } from '../lib/tools.js';

test('system-label aliases and CSV entries use the same normalization for policy and execution', () => {
  for (const [field, label, canonical] of [['addLabels', ' trash ', 'TRASH'], ['addLabels', 'SpAm', 'SPAM'],
    ['removeLabels', ' inbox ', 'INBOX'], ['addLabels', ' secretary/processed ', 'Secretary/Processed'],
    ['addLabels', 'Label_123', 'Label_123'], ['addLabels', 'Review, trash', 'TRASH']]) {
    const params = { action: 'label_threads', ids: ['thread-1'], [field]: [label] };
    const approval = approvalFor('gmail_secretary_organize', params);
    assert.ok(approval, label);
    assert.ok(approval.description.includes(canonical));
    const command = buildOrganizeCommand(params, { account: 'auto' });
    assert.ok(command.args.some(arg => arg.startsWith(field === 'addLabels' ? '--add=' : '--remove=') && arg.includes(canonical)));
  }
  assert.equal(approvalFor('gmail_secretary_organize', { action: 'label_threads', ids: ['thread-1'], addLabels: ['Secretary/Review'], removeLabels: ['UNREAD'] }), null);
});

test('ambiguous quoted/control-character labels fail closed in the hook and builder', () => {
  const hooks = new Map();
  createPlugin(x => x).register({ registerTool() {}, on: (name, fn) => hooks.set(name, fn) });
  for (const label of ['"TRASH"', 'Review\nSPAM', 'Review\rTRASH']) {
    const params = { action: 'label_threads', ids: ['thread-1'], addLabels: [label] };
    assert.throws(() => buildOrganizeCommand(params, { account: 'auto' }));
    assert.equal(hooks.get('before_tool_call')({ toolName: 'gmail_secretary_organize', params }, {}).block, true);
  }
});
