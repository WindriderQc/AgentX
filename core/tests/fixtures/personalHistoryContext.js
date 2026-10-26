'use strict';
const { createHash } = require('node:crypto');
const hash = value => createHash('sha256').update(value).digest('hex');
function input(n = 1) {
  const body = `Synthetic source ${n}: a move was proposed for summer.\nIt has not been independently confirmed.\fArchive page 2.`;
  return { expectedContextRevision: 0, importId: `example:moment-${n}`,
    entry: { kind: 'fact', text: `Synthetic move ${n}`, sourceDate: null,
      source: { system: 'document', id: `document-${n}`, sourceSha256: hash(body), findingId: hash(`finding-${n}`) } },
    timeline: { legacyId: `legacy-${n}`, title: `Synthetic move ${n}`, category: 'home', date: '2004', precision: 'year',
      endDate: null, endPrecision: 'unknown', ongoing: false, hypothesis: true, reviewState: 'confirmed', confirmationBasis: 'owner-testimony',
      occurrenceStatus: 'planned', ageStartWindow: { start: '2003-01-01', end: '2005-12-31' },
      sourceIds: [`source-${n}`], claimsWithExactQuotes: [{ sourceId: `source-${n}`, quote: `Synthetic source ${n}: a move was proposed for summer.` }],
      narrative: { chapterId: 'example-chapter', title: 'Synthetic early years', pathId: 'places', order: n, pendingDate: true } },
    sourceRecords: [{ id: `source-${n}`, kind: 'document', subject: 'Synthetic archive', body, bodySha256: hash(body),
      nativePath: '/synthetic/archive/document.txt', authority: 'source-record', metadataOnly: false }], relations: [], media: [] };
}
module.exports = { input, hash };
