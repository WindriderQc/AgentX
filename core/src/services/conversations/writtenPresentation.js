'use strict';

const written = require('../../../public/js/conversation-written');

// Seal source provenance on the same canonical turn. Speech retains its existing
// replyText field and references this source revision; it cannot rewrite it.
function captureWritten({ draft, traceId, runId, previous, status = 'complete', readAloud = false }) {
  if (!written.valid(draft)) throw new TypeError('A safe ordered written presentation is required');
  const segments = draft.segments.map(segment => segment.kind === 'text'
    ? { kind: 'text', text: segment.text } : { kind: 'display', blockId: segment.blockId });
  const same = written.valid(previous) && previous.sourceTurnId === traceId
    && (previous.sourceRunId || '') === (runId || '') && previous.status === status
    && JSON.stringify(previous.segments) === JSON.stringify(segments);
  const revision = same ? previous.revision : Math.max(0, Number(previous?.revision) || 0) + 1;
  return {
    written: { version: 1, revision, sourceTurnId: traceId,
      ...(runId ? { sourceRunId: runId } : {}), status, segments },
    speechProjection: { version: 1, sourceRevision: revision,
      method: readAloud ? 'full-reading' : 'reply-channels', sourceTurnId: traceId }
  };
}

module.exports = { captureWritten };
