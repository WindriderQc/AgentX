'use strict';

const { createReplyChannels, storedDisplay } = require('./reply-channels');
const { valid } = require('../../public/js/conversation-written');
const { captureWritten } = require('../../src/services/conversations/writtenPresentation');
const { createHash } = require('node:crypto');

const keepSource = (input, previous) => ({ written: previous.written, display: previous.display,
  speechProjection: previous.speechProjection, replySha256: createHash('sha256').update(input.replyText).digest('hex') });

// Every existing Household writer crosses this boundary, including fixed
// answers and late native recovery. It owns no transcript or native agent loop.
function presentationForTurn(input, { previous, childSafe = false, replaceSource = false } = {}) {
  if (typeof input.replyText !== 'string') return {};
  if (!input.written && !replaceSource && valid(previous?.written) && previous.written.status === 'complete') {
    return keepSource(input, previous);
  }
  let draft = input.written, display = input.display || [], replyText = input.replyText;
  if (!valid(draft)) {
    const channels = createReplyChannels({ allowSecrets: !childSafe });
    channels.push(replyText);
    const parsed = channels.end();
    draft = { ...parsed.written, segments: [...parsed.written.segments] };
    const seen = new Set(parsed.display.map(block => block.id));
    display = display.map(block => {
      const id = seen.has(block.id) ? `d${seen.size + 1}` : block.id;
      seen.add(id); draft.segments.push({ kind: 'display', blockId: id });
      return id !== block.id ? { ...block, id } : block;
    });
    // Already composed display is a deterministic complement after the reply.
    display = [...parsed.display, ...display];
    replyText = parsed.say;
  }
  if (childSafe) display = display.filter(block => block.kind !== 'secret');
  display = storedDisplay(display);
  const referenced = new Set(draft.segments.filter(segment => segment.kind === 'display').map(segment => segment.blockId));
  draft = { ...draft, segments: [...draft.segments, ...display.filter(block => !referenced.has(block.id))
    .map(block => ({ kind: 'display', blockId: block.id }))] };
  const ids = new Set(display.map(block => block.id));
  const incomplete = display.some(block => block.partial) || draft.segments.some(segment => segment.kind === 'display' && !ids.has(segment.blockId));
  const status = incomplete ? 'partial' : input.writtenStatus || (input.outcome === 'pending' ? 'pending'
    : ['cancelled', 'failed'].includes(input.outcome) || input.interrupted && !input.written ? 'partial' : 'complete');
  if (status !== 'complete' && valid(previous?.written) && previous.written.status === 'complete') return keepSource(input, previous);
  return { replyText, display, replySha256: createHash('sha256').update(replyText).digest('hex'), ...captureWritten({ draft, traceId: input.traceId,
    runId: replaceSource ? undefined : input.toolEvidence?.runId || input.toolEvidence?.run?.runId,
    kind: replaceSource ? 'scene-receipt' : 'answer',
    previous: previous?.written, status, readAloud: input.speechProjection?.method === 'full-reading' }) };
}

// The canonical writer can add fixed-answer references that had no streamed
// channels. Return those blocks too, while preserving live rendering metadata
// and the existing private-only one-time secret presentation.
function displayForReply(audit, live = []) {
  if (!valid(audit.written) || !Array.isArray(audit.display)) return live;
  return audit.display.map(block => {
    const original = live.find(item => item.kind === block.kind && (block.kind === 'secret'
      ? item.id === block.id : item.body === block.body && item.title === block.title));
    return original ? { ...original, id: block.id } : block;
  });
}

module.exports = { presentationForTurn, displayForReply };
