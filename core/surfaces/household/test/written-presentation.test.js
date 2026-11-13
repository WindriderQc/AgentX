'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const written = require('../../../public/js/conversation-written');
const { captureWritten } = require('../../../src/services/conversations/writtenPresentation');
const { createReplyChannels, storedDisplay, historyText } = require('../reply-channels');
const { presentationForTurn, displayForReply } = require('../turn-presentation');

function parse(source, options = {}) {
  const events = [], channels = createReplyChannels({ ...options, onWritten: event => events.push(event) });
  for (let i = 0; i < source.length; i += 7) channels.push(source.slice(i, i + 7));
  return { ...channels.end(), events };
}

test('safe live events, sealed source and reloaded JSON preserve one complete ordered answer', () => {
  const body = 'A complete synthetic explanation. '.repeat(500) + 'LAST DETAIL';
  const parsed = parse(`Before https://example.test/one. <show kind="text">${body}</show> After.`);
  const stream = written.stream();
  for (const event of parsed.events) {
    assert.equal(stream.push(event), true);
    assert.equal(stream.push(event), false, 'a repeated transport event cannot duplicate source text');
  }
  const source = captureWritten({ draft: parsed.written, traceId: 'turn-1', runId: 'native-1' });
  const saved = JSON.parse(JSON.stringify({ ...source, replyText: parsed.say, display: storedDisplay(parsed.display) }));
  assert.equal(written.text(stream.snapshot()), written.text(saved));
  assert.equal(written.text(saved).split(body).length, 2, 'full body occurs exactly once');
  assert.ok(written.text(saved).startsWith('Before https://example.test/one.'));
  assert.ok(written.text(saved).endsWith('After.'));
  assert.equal(saved.written.sourceTurnId, 'turn-1');
  assert.equal(saved.written.sourceRunId, 'native-1');
  assert.equal(saved.speechProjection.sourceRevision, saved.written.revision);
  const history = historyText(saved.replyText, saved.display, saved.written);
  assert.ok(history.indexOf('Before') < history.indexOf(body));
  assert.ok(history.indexOf(body) < history.indexOf('After.'));
});

test('a source revision changes only for a changed source or completion state', () => {
  const parsed = parse('Complete answer.');
  const first = captureWritten({ draft: parsed.written, traceId: 'turn', status: 'partial' });
  const same = captureWritten({ draft: parsed.written, traceId: 'turn', status: 'partial', previous: first.written });
  const complete = captureWritten({ draft: parsed.written, traceId: 'turn', previous: same.written, readAloud: true });
  assert.equal(first.written.revision, same.written.revision);
  assert.equal(complete.written.revision, same.written.revision + 1);
  assert.equal(complete.speechProjection.method, 'full-reading');
  assert.equal(first.written.status, 'partial', 'later source sealing cannot mutate an earlier snapshot');
});

test('fixed answers and native final output cross the same safe presentation boundary', () => {
  const fixed = presentationForTurn({ traceId: 'fixed', replyText: 'Three useful items.',
    display: [{ id: 'b1', kind: 'list', body: '- First\n- Second\n- Third' }], routeTier: 'deterministic' });
  assert.ok(written.text(fixed).includes('Third'));
  assert.equal(fixed.written.sourceTurnId, 'fixed');
  assert.equal(fixed.written.status, 'complete');
  const native = presentationForTurn({ traceId: 'native', replyText: 'Short speech. <show kind="text">Complete writing.</show>',
    toolEvidence: { runId: 'native-run' } });
  assert.equal(native.replyText, 'Short speech.');
  assert.ok(written.text(native).includes('Complete writing.'));
  assert.equal(native.written.sourceRunId, 'native-run');
});

test('a late spoken projection cannot replace a completed written source or its blocks', () => {
  const parsed = parse('Short speech. <show kind="text">All the important details.</show>');
  const previous = presentationForTurn({ traceId: 'turn', replyText: parsed.say, written: parsed.written, display: parsed.display });
  const late = presentationForTurn({ traceId: 'turn', replyText: 'An even shorter summary.', display: [] }, { previous });
  assert.deepEqual(late.written, previous.written);
  assert.deepEqual(late.display, previous.display);
  assert.ok(written.text(late).includes('All the important details.'));
  const fragment = parse('An unfinished replacement.');
  const latePartial = presentationForTurn({ traceId: 'turn', replyText: fragment.say, written: fragment.written,
    writtenStatus: 'partial', display: [] }, { previous });
  assert.deepEqual(latePartial.written, previous.written, 'an explicit late fragment cannot replace a complete source');
  const recovered = parse('Recovered full answer.');
  const changed = presentationForTurn({ traceId: 'turn', replyText: recovered.say, written: recovered.written,
    toolEvidence: { runId: 'recovered-run' } }, { previous });
  assert.equal(changed.written.revision, previous.written.revision + 1);
});

test('generation cancellation and playback interruption have separate source completeness', () => {
  const partial = parse('Beginning. <show kind="text">Unfinished body');
  const stopped = presentationForTurn({ traceId: 'stopped', replyText: partial.say, written: partial.written,
    display: partial.display, outcome: 'cancelled', writtenStatus: 'partial' });
  assert.equal(stopped.written.status, 'partial');
  assert.equal(presentationForTurn({ traceId: 'unclosed', replyText: partial.say, written: partial.written,
    display: partial.display, writtenStatus: 'complete' }).written.status, 'partial', 'an unclosed block remains partial');
  const finished = parse('The complete answer.');
  const unheard = presentationForTurn({ traceId: 'unheard', replyText: finished.say, written: finished.written,
    interrupted: true, writtenStatus: 'complete' });
  assert.equal(unheard.written.status, 'complete');
});

test('written events and history exclude secret bodies, native media protocol and consultations', () => {
  const secret = 'sk-' + 'a1'.repeat(40);
  for (const allowSecrets of [false, true]) {
    const parsed = parse(`Before ${secret}. <show kind="secret">DO_NOT_RETAIN</show>`
      + '<show kind="consult" title="helper">DO_NOT_DISPLAY</show> MEDIA:/private/audio.wav After.', { allowSecrets });
    assert.doesNotMatch(JSON.stringify(parsed.events), /DO_NOT_RETAIN|DO_NOT_DISPLAY|sk-|MEDIA:|private\/audio/);
    assert.doesNotMatch(written.text({ written: parsed.written, display: storedDisplay(parsed.display) }), /DO_NOT_RETAIN|DO_NOT_DISPLAY|sk-|MEDIA:/);
    const family = presentationForTurn({ traceId: 'family', replyText: `<show kind="secret">${secret}</show> Safe.` }, { childSafe: true });
    assert.deepEqual(family.display, []);
  }
});

test('missing stream events remain partial and legacy turns gain no invented source', () => {
  const stream = written.stream(), parsed = parse('A sufficiently long streamed reply.');
  assert.equal(stream.push(parsed.events[1]), false);
  assert.equal(stream.snapshot().written.gap, true);
  assert.equal(stream.snapshot().written.status, 'partial');
  const legacy = { replyText: 'Recorded speech.', display: [{ id: 'b1', kind: 'text', body: 'Recorded screen content.' }] };
  assert.equal(written.parts(legacy), null);
  assert.ok(written.text(legacy).includes('Recorded screen content.'));
  assert.equal(legacy.written, undefined);
  assert.match(written.text({ written: { version: 1, segments: [{ kind: 'display', blockId: 'missing' }] } }), /indisponible/);
});

test('a verified late display joins the same source without repeating reading projections', () => {
  const parsed = parse('Summary. <show kind="text">Reference https://example.test/docs</show>', { readAloud: true });
  const result = presentationForTurn({ traceId: 'turn', replyText: parsed.say, written: parsed.written,
    display: [...parsed.display, { id: 'late-image', kind: 'image', title: 'Verified image', body: 'Synthetic illustration' }] });
  assert.equal(result.display.length, 2);
  assert.equal(written.text(result).split('https://example.test/docs').length, 2);
  assert.match(written.text(result), /Verified image/);
});

test('an authoritative scene rejection revises the source without impersonating a native answer', () => {
  const previous = presentationForTurn({ traceId: 'scene-turn', replyText: 'Proposed scene.', toolEvidence: { runId: 'model-run' } });
  const rejected = presentationForTurn({ traceId: 'scene-turn', replyText: 'Browser rejected the scene.',
    sceneReceipt: { status: 'rejected' }, toolEvidence: { runId: 'model-run' } }, { previous, replaceSource: true });
  assert.equal(written.text(rejected), 'Browser rejected the scene.');
  assert.equal(rejected.written.revision, previous.written.revision + 1);
  assert.equal(rejected.written.sourceKind, 'scene-receipt');
  assert.equal(rejected.written.sourceRunId, undefined);
  const spokenUpdate = presentationForTurn({ traceId: 'scene-turn', replyText: 'Short summary.' }, { previous });
  assert.equal(written.text(spokenUpdate), 'Proposed scene.');
});

test('HTTP replies include writer-created blocks and preserve live metadata without retaining a secret', () => {
  const live = [{ id: 'b1', kind: 'math', title: 'Plot', body: 'y = x^2', plot: { verified: true } }];
  const audit = presentationForTurn({ traceId: 'fixed', replyText: 'Reference https://example.test/docs.', display: live });
  const response = { written: audit.written, display: displayForReply(audit, live) };
  assert.doesNotMatch(written.text(response), /indisponible/);
  assert.ok(written.text(response).includes('https://example.test/docs'));
  assert.equal(response.display.find(block => block.kind === 'math').plot.verified, true);
  assert.equal(response.display.find(block => block.kind === 'math').id, 'd2');
  const parsed = parse('<show kind="secret">SYNTHETIC_ONE_TIME</show> Safe.', { allowSecrets: true });
  const secretAudit = presentationForTurn({ traceId: 'private', replyText: parsed.say, written: parsed.written, display: parsed.display });
  assert.doesNotMatch(JSON.stringify(secretAudit), /SYNTHETIC_ONE_TIME/);
  assert.equal(displayForReply(secretAudit, parsed.display)[0].body, 'SYNTHETIC_ONE_TIME');
  assert.doesNotMatch(written.text({ written: secretAudit.written, display: displayForReply(secretAudit, parsed.display) }), /SYNTHETIC_ONE_TIME/);
});
