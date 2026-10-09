import test from 'node:test';
import assert from 'node:assert/strict';
import { isOwnerTarget, outboundApproval } from '../policy.js';

const ownerTargets = ['telegram:111', 'telegram:-100222'];

test('reads, replies in the current conversation and owner destinations pass', () => {
  assert.equal(outboundApproval({ action: 'read', channel: 'telegram', target: '999' }, { ownerTargets }), null);
  assert.equal(outboundApproval({ action: 'reactions', target: 'channel:5' }, { ownerTargets }), null);
  assert.equal(outboundApproval({ action: 'send', message: 'Bonjour' }, { ownerTargets }), null);
  assert.equal(outboundApproval({ action: 'send', channel: 'telegram', target: '111', message: 'Brief' }, { ownerTargets }), null);
  assert.equal(outboundApproval({ action: 'send', target: 'telegram:-100222:topic:330', message: 'Alert' }, { ownerTargets }), null);
  assert.equal(outboundApproval({ action: 'send', channel: 'telegram', target: '-100222', threadId: '330' }, { ownerTargets }), null);
});

test('anyone else needs the owner\'s approval, whatever the action', () => {
  const send = outboundApproval({ action: 'send', channel: 'telegram', target: '@someone', message: 'Hi there' }, { ownerTargets });
  assert.deepEqual(send, { title: 'Message outside the household', description: 'send to telegram:@someone — Hi there', severity: 'warning' });
  assert.equal(outboundApproval({ target: '333' }, { ownerTargets }).description, 'send to 333');
  assert.equal(outboundApproval({ action: 'delete', channel: 'telegram', target: '444', messageId: '1' }, { ownerTargets }).severity, 'critical');
  assert.ok(outboundApproval({ action: 'poll', channel: 'telegram', target: '1110' }, { ownerTargets }), 'a prefix of an owner id is not that owner');
  assert.ok(outboundApproval({ action: 'send', channel: 'discord', target: '111' }, { ownerTargets }), 'the same id on another channel is not the owner');
  assert.ok(outboundApproval({ action: 'send', channel: 'telegram', target: '111' }, { ownerTargets: [] }), 'no owner list: every explicit destination asks');
});

test('owner targets match by channel and cover topics only below the listed conversation', () => {
  assert.equal(isOwnerTarget(['telegram:-100222'], 'telegram', '-100222:topic:5'), true);
  assert.equal(isOwnerTarget(['telegram:-100222'], '', 'telegram:-100222'), true);
  assert.equal(isOwnerTarget(['-100222'], 'telegram', '-100222'), true);
  assert.equal(isOwnerTarget(['telegram:-100222'], 'telegram', '-1002223'), false);
  assert.equal(isOwnerTarget(['telegram:-100222'], 'slack', '-100222'), false);
});

test('the plugin entry parses (the OpenClaw SDK import is stubbed)', async () => {
  const { readFile } = await import('node:fs/promises');
  const source = await readFile(new URL('../index.js', import.meta.url), 'utf8');
  const body = source.replace(/^import .*$/gm, '').replace('export default', 'return');
  assert.doesNotThrow(() => new Function('definePluginEntry', 'outboundDecision', 'nativeActionProvenance', 'toolActionReceipt', body));
});
