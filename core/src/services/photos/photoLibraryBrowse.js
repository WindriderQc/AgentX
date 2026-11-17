'use strict';
// Global owner review reads existing content cards only: no NAS, indexing or inference.
const Cards = require('../../../models/PhotoProcessingCard');
const Decisions = require('../../../models/PhotoProcessingDecision');
const Similarity = require('../../../models/PhotoLibrarySimilarity');
const suggestions = require('./photoFrameSuggestions');
const { fail } = require('./importFiles');
const FILTERS = {
  all: {}, suggested: { _suggestion: 'suggested' },
  frame: { 'frame.selected': true }, review: { 'review.approved': { $ne: true } },
  reviewed: { 'review.approved': true }, privacy: { 'analysis.card.proposal.privacyReview': true },
};
const SORTS = { recent: { _analysisDate: -1, _id: 1 }, oldest: { _analysisDate: 1, _id: 1 },
  taken: { 'metadata.exif.dateTimeOriginal': -1, _id: 1 }, quality: { _quality: 1, _id: 1 } };
const escapeRegex = value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
function query(input = {}) {
  const allowed = ['op', 'filter', 'search', 'quality', 'order', 'offset', 'limit', 'similarity', 'group'];
  if (Object.keys(input).some(k => !allowed.includes(k))) throw fail('INVALID_LIBRARY_QUERY', 'Unknown library query');
  const { filter = 'all', search = '', quality = 'all', order = 'recent', offset = 0, limit = 60 } = input;
  const similarity = input.similarity ?? (filter === 'suggested' ? 'grouped' : 'all'), group = input.group ?? '';
  if (typeof filter !== 'string' || !Object.hasOwn(FILTERS, filter) || typeof order !== 'string' || !Object.hasOwn(SORTS, order)
    || typeof search !== 'string' || search.length > 120 || /[\x00-\x1f]/.test(search)
    || !['all', 'bonne', 'moyenne', 'faible', 'inconnue'].includes(quality)
    || !Number.isSafeInteger(offset) || offset < 0 || offset > 1000000
    || !Number.isSafeInteger(limit) || limit < 1 || limit > 60)
    throw fail('INVALID_LIBRARY_QUERY', 'Invalid library filters or page');
  if (!['grouped', 'all'].includes(similarity) || typeof group !== 'string' || group && !/^[a-f0-9]{64}$/.test(group))
    throw fail('INVALID_LIBRARY_QUERY', 'Invalid similarity view');
  const match = { ...FILTERS[filter] };
  if (group) match._group = group;
  if (quality !== 'all') match['analysis.card.proposal.quality'] = quality;
  if (search.trim()) {
    const literal = { $regex: escapeRegex(search.trim()), $options: 'i' };
    match.$or = ['analysis.card.proposal.description', 'analysis.card.proposal.tags', 'review.description', 'review.tags',
      'metadata.exif.city', 'metadata.exif.country', 'metadata.exif.make', 'metadata.exif.model',
      'metadata.people.name', 'projection.relativePath'].map(field => ({ [field]: literal }));
  }
  return { filter, search, quality, order, offset, limit, similarity, group, match };
}
const countIf = condition => ({ $sum: { $cond: [condition, 1, 0] } });
const approved = { $eq: ['$review.approved', true] }, selected = { $eq: ['$frame.selected', true] };
const fields = { _id: 1, assetId: 1, metadata: 1, review: 1, frame: 1, pendingDecision: 1,
  'analysis.analysisId': 1, 'analysis.card.proposal': 1, 'analysis.card.provenance.createdAt': 1,
  'projection.relativePath': 1, 'projection.runId': 1, 'projection.requestId': 1 };
function similarityFields(index) {
  const entries = index?.version === 1 ? index.entries || [] : [];
  const keys = entries.map(e => e.sha256+':'+e.assetId), groups = entries.map(e => e.groupId);
  const position = { $indexOfArray: [{ $literal: keys }, { $concat: ['$_id', ':', '$assetId'] }] };
  return { _indexed: { $gte: [position, 0] },
    _group: { $cond: [{ $gte: [position, 0] }, { $arrayElemAt: [{ $literal: groups }, position] }, { $concat: ['single:', '$_id'] }] } };
}
function createPhotoLibraryBrowse({ config, control, cards = Cards, decisions = Decisions, similarity = Similarity } = {}) {
  return async function browse(input) {
    const q = query(input), fixed = config(), state = await control.status();
    const empty = { total: 0, suggested: 0, frame: 0, review: 0, reviewed: 0, privacy: 0 };
    if (!fixed) return { configured: false, frameEnabled: false, control: state, summary: empty,
      results: [], total: 0, offset: q.offset, limit: q.limit };
    const base = { libraryId: fixed.libraryId, 'metadata.type': 'IMAGE', 'analysis.state': 'completed',
      'analysis.card.proposal.description': { $type: 'string' } };
    const index = await similarity.findById(fixed.libraryId).lean();
    const grouped = q.similarity === 'grouped' && !q.group;
    const grouping = grouped ? [{ $group: { _id: '$_group', representative: { $first: '$$ROOT' }, size: { $sum: 1 } } },
      { $replaceWith: { $mergeObjects: ['$representative', { _nearSize: '$size' }] } }] : [];
    const [result] = await cards.aggregate([
      { $match: base },
      { $project: { ...fields, createdAt: 1 } },
      { $addFields: { _suggestion: suggestions.reason, ...similarityFields(index) } },
      { $facet: {
        summary: [{ $group: { _id: null, total: { $sum: 1 },
          suggested: countIf({ $eq: ['$_suggestion', 'suggested'] }), indexed: countIf('$_indexed'),
          frame: countIf(selected), reviewed: countIf(approved), review: countIf({ $not: [approved] }),
          privacy: countIf({ $eq: ['$analysis.card.proposal.privacyReview', true] }) } }],
        count: [{ $match: q.match }, ...(grouped ? [{ $group: { _id: '$_group' } }] : []), { $count: 'total' }],
        images: [{ $match: q.match }, { $count: 'total' }],
        results: [{ $match: q.match }, { $addFields: {
          _analysisDate: { $ifNull: ['$analysis.card.provenance.createdAt', { $dateToString: { date: '$createdAt', onNull: '' } }] },
          _quality: { $switch: { branches: ['bonne', 'moyenne', 'faible'].map((value, index) =>
            ({ case: { $eq: ['$analysis.card.proposal.quality', value] }, then: index })), default: 3 } },
        } }, { $sort: SORTS[q.order] }, ...grouping, { $sort: SORTS[q.order] }, { $skip: q.offset }, { $limit: q.limit },
        { $project: { ...fields, _suggestion: 1, _group: 1, _nearSize: 1 } }],
      } },
    ]).option({ maxTimeMS: 10000 });
    const pendingIds = result.results.map(row => row.pendingDecision).filter(Boolean);
    const intents = pendingIds.length ? await decisions.find({ _id: { $in: pendingIds } }).lean() : [];
    const byId = new Map(intents.map(row => [row._id, row]));
    const results = result.results.map(row => {
      const pending = byId.get(row.pendingDecision);
      return { sha256: row._id, assetId: row.assetId, metadata: row.metadata, proposal: row.analysis.card.proposal,
        analysisId: row.analysis.analysisId, analyzedAt: row.analysis.card.provenance?.createdAt || null,
        review: row.review, frame: row.frame,
        suggestion: { eligible: row._suggestion === 'suggested', reason: row._suggestion },
        similarity: { groupId: row._group?.startsWith('single:') ? null : row._group, size: row._nearSize || 1 },
        source: row.projection,
        ...(row.pendingDecision ? { pendingDecision: true } : {}),
        ...(pending ? { pendingIntent: { writeId: pending._id, kind: pending.kind,
          value: pending.value, expectedRevision: pending.expectedRevision } } : {}) };
    });
    const { _id, indexed = 0, ...summary } = result.summary[0] || empty;
    return { configured: true, frameEnabled: Boolean(fixed.frameAlbumId), control: state, summary,
      similarity: { mode: grouped ? 'grouped' : 'all', indexed, total: summary.total, observedAt: index?.observedAt || null,
        images: result.images[0]?.total || 0, group: q.group },
      results, total: result.count[0]?.total || 0, offset: q.offset, limit: q.limit };
  };
}
module.exports = { createPhotoLibraryBrowse, query };
