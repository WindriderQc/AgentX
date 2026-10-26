'use strict';

function projectContext(row, { includeSourceBodies = false } = {}) {
  const context = row.reviewState !== 'forgotten' && row.context;
  if (!context) return { sourceKey: row.key, importId: null, contextRevision: 0, contextHash: null, timeline: null, context: null };
  const sources = (context.sources || []).map(source => {
    const result = { ...source };
    if (!includeSourceBodies) delete result.body;
    return result;
  });
  return { sourceKey: row.key, importId: context.importId, contextRevision: context.revision, contextHash: context.inputHash,
    timeline: { ...context.timeline, ...(context.overrides || {}) },
    context: { importId: context.importId, revision: context.revision, inputHash: context.inputHash,
      reviewAuthority: context.reviewAuthority, sources, relations: context.relations || [], media: context.media || [],
      importedTimeline: context.timeline, ownerEdits: context.ownerEdits || [], ownerEditedAt: context.ownerEditedAt || null } };
}

module.exports = { projectContext };
