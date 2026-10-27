'use strict';

const { createHash } = require('node:crypto');
const hash = value => createHash('sha256').update(value).digest('hex');
const text = (value, max) => typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, max) : '';

// The search capability owns audience, current-fact filtering, score floors and
// native embedding admission. This projection never reads a model-named path.
function researchSources(results, observedAt) {
  const seen = new Set();
  return (Array.isArray(results) ? results : []).flatMap(row => {
    const metadata = row?.metadata || {};
    const documentId = text(metadata.documentId || row.documentId, 160);
    const excerpt = text(row?.text || row?.content, 1200).trim();
    if (!documentId || !excerpt) return [];
    const id = hash(documentId + '\n' + excerpt);
    if (seen.has(id)) return []; seen.add(id);
    return [{ id, documentId, chunkId: text(metadata.chunkId || row.id, 160),
      title: text(metadata.title || metadata.filename || metadata.source || documentId, 200),
      source: text(metadata.source, 120), excerpt, excerptSha256: hash(excerpt), observedAt,
      ...(typeof row.score === 'number' && Number.isFinite(row.score) ? { score: row.score } : {}) }];
  }).slice(0, 3);
}

function researchQuery(frame) {
  const selected = typeof frame.screen?.selection?.id === 'string' ? frame.screen.selection : null;
  return [frame.request, selected ? 'Selected display reference: ' + JSON.stringify(selected).slice(0, 1000) : '']
    .filter(Boolean).join('\n').slice(0, 4000);
}

function researchContext(research) {
  return research?.sources?.length ? research.sources.map(row => [
    'SOURCE ' + row.id, 'DOCUMENT ' + row.documentId, 'TITLE ' + row.title, 'EXCERPT', row.excerpt, 'END SOURCE'
  ].join('\n')).join('\n\n') : '';
}

module.exports = { researchSources, researchQuery, researchContext };
