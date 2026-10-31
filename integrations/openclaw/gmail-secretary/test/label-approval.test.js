import test from 'node:test';
import assert from 'node:assert/strict';
import { approvalFor, buildOrganizeCommand, createPlugin } from '../lib/tools.js';

test('system-label aliases and CSV entries use the same normalization for policy and execution', () => {
  for (const [field, label, canonical] of [['addLabels', ' trash ', 'TRASH'], ['addLabels', 'SpAm', 'SPAM'],
    ['removeLabels', ' inbox ', 'INBOX'], ['addLabels', ' secretary/processed ', 'Secretary/Processed'],
    ['addLabels', 'Label_123', 'Label_123'], ['addLabels', 'Review, trash', 'TRASH'],
    ['addLabels', '\u0085TRASH\u0085', 'TRASH'], ['addLabels', '\u0085spam\u0085', 'SPAM'],
    ['removeLabels', '\u0085inbox\u0085', 'INBOX'],
    ['addLabels', '\u0085Secretary/Processed\u0085', 'Secretary/Processed'],
    ['addLabels', '\u0085Label_123\u0085', 'Label_123'],
    ['removeLabels', '\u0130NBOX', 'INBOX'], ['removeLabels', '\u0085\u0130NBOX\u0085', 'INBOX']]) {
    const params = { action: 'label_threads', ids: ['thread-1'], [field]: [label] };
    const approval = approvalFor('gmail_secretary_organize', params);
    assert.ok(approval, label);
    assert.ok(approval.description.includes(canonical));
    const command = buildOrganizeCommand(params, { account: 'auto' });
    assert.ok(command.args.some(arg => arg.startsWith(field === 'addLabels' ? '--add=' : '--remove=') && arg.includes(canonical)));
  }
  assert.equal(approvalFor('gmail_secretary_organize', { action: 'label_threads', ids: ['thread-1'], addLabels: ['Secretary/Review'], removeLabels: ['UNREAD'] }), null);
});

test('normalization does not rewrite unrelated Unicode label names through uppercase expansion', () => {
  const params = { action: 'label_threads', ids: ['thread-1'], addLabels: ['\u017fpam', 'tra\u017fh'] };
  assert.equal(approvalFor('gmail_secretary_organize', params), null);
  assert.ok(buildOrganizeCommand(params, { account: 'auto' }).args.includes('--add=\u017fpam,tra\u017fh'));
});

test('Unicode boundary whitespace cannot hide system labels from the approval policy', () => {
  for (const space of ['\u0085', '\u00a0', '\u1680', '\u2000', '\u2009', '\u2028', '\u2029', '\u202f', '\u205f', '\u3000', '\ufeff']) {
    const params = { action: 'label_threads', ids: ['thread-1'], addLabels: [`${space}TRASH${space}`] };
    assert.equal(approvalFor('gmail_secretary_organize', params).severity, 'critical');
    assert.ok(buildOrganizeCommand(params, { account: 'auto' }).args.includes('--add=TRASH'));
  }
});

test('native literal quoted or interior-newline labels remain usable without changing their names', () => {
  for (const label of ['"TRASH"', 'Review\nSPAM', 'Review\rTRASH']) {
    const params = { action: 'label_threads', ids: ['thread-1'], addLabels: [label] };
    assert.equal(approvalFor('gmail_secretary_organize', params), null);
    assert.ok(buildOrganizeCommand(params, { account: 'auto' }).args.includes(`--add=${label}`));
  }
  const params = { action: 'label_threads', ids: ['thread-1'], addLabels: ['"Review",TRASH'] };
  assert.equal(approvalFor('gmail_secretary_organize', params).severity, 'critical');
  assert.ok(buildOrganizeCommand(params, { account: 'auto' }).args.includes('--add="Review",TRASH'));
});

test('protected effects remain visible before long or multiline label details are abbreviated', () => {
  const params = { action: 'label_threads', ids: ['thread-1'],
    addLabels: ['Review'.repeat(40), 'Review\nTRASH', 'SPAM', 'TRASH'], removeLabels: ['INBOX'] };
  const { description } = approvalFor('gmail_secretary_organize', params);
  for (const risk of ['add TRASH', 'add SPAM', 'remove INBOX']) assert.ok(description.includes(risk));
  assert.equal(description.includes('\n'), false);
});

test('invalid label types fail closed in the hook and builder', () => {
  const hooks = new Map();
  createPlugin(x => x).register({ registerTool() {}, on: (name, fn) => hooks.set(name, fn) });
  for (const label of [null, 1, {}]) {
    const params = { action: 'label_threads', ids: ['thread-1'], addLabels: [label] };
    assert.throws(() => buildOrganizeCommand(params, { account: 'auto' }));
    assert.equal(hooks.get('before_tool_call')({ toolName: 'gmail_secretary_organize', params }, {}).block, true);
  }
});
