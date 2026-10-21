'use strict';

// Router tasks whose model cannot be overridden in place. RAG embeds its
// documents with the model of its serving collection; a saved override would
// change nothing but the display. The Nerve Center changes it through a queued
// rebuild instead (POST /api/nerve-center/embeddings/change).
const REBUILD_ONLY_TASKS = new Set(['embeddings']);

function assertEditableTask(taskType) {
  if (REBUILD_ONLY_TASKS.has(taskType)) {
    throw Object.assign(new Error('The embedding model changes through a queued rebuild: use Nerve Center → Routing → Embeddings'), {
      statusCode: 409, code: 'EMBEDDINGS_CHANGE_REQUIRES_REINDEX'
    });
  }
  return taskType;
}

module.exports = { assertEditableTask, REBUILD_ONLY_TASKS };
