'use strict';

/**
 * Prompt-cache misses over `inferencelogs` (#364).
 *
 * Rows carry `promptCache` (routing/promptCacheAttribution.js). Per group, by
 * host and model unless asked otherwise, this reports how many calls fall
 * under each verdict, the characters of reusable prefix lost, the prefill
 * time that cost against all prefill measured, and the labels that most often
 * came in between. It reads only counts and server-attested labels.
 */

const { GROUP_FIELDS, parseGroupBy } = require('./inferenceDistributionService');
const { VERDICTS } = require('./routing/promptCacheAttribution');

const DEFAULT_GROUP_BY = Object.freeze(['hostKey', 'model']);
const TOP_INTERLEAVERS = 5;

const VERDICT_DESCRIPTIONS = Object.freeze({
  warm: 'The request just before left this call its longest reusable prefix.',
  interleaved: 'Another request reached the model between this call and the earlier one it continues, so part of its reusable prefix was evaluated again.',
  reload: 'The model was loaded again (loadMs of at least one second), so its whole reusable prefix was evaluated again.',
  cold: 'No recent request to this host and model shares a prefix with this call; nothing was reusable.',
  untracked: 'Core had seen no earlier request to this host and model since it started.',
});

function parsePromptCacheGroupBy(raw) {
  return raw == null || String(raw).trim() === '' ? [...DEFAULT_GROUP_BY] : parseGroupBy(raw);
}

function groupId(groupBy) {
  const id = {};
  for (const field of groupBy) id[field] = { $ifNull: [GROUP_FIELDS[field], 'unknown'] };
  return id;
}

const number = field => ({ $cond: [{ $isNumber: field }, field, 0] });

function accumulators() {
  const fields = {
    calls: { $sum: 1 },
    chars: { $sum: number('$promptCache.chars') },
    lostChars: { $sum: number('$promptCache.lostChars') },
    lostPrefillMs: { $sum: number('$promptCache.lostPrefillMs') },
    // Prefill measured on the rows whose lost time could be computed.
    promptEvalMs: {
      $sum: { $cond: [{ $isNumber: '$promptCache.lostPrefillMs' }, number('$promptEvalMs'), 0] }
    },
  };
  for (const verdict of VERDICTS) {
    fields[`verdict__${verdict}`] = { $sum: { $cond: [{ $eq: ['$promptCache.verdict', verdict] }, 1, 0] } };
  }
  return fields;
}

function buildPromptCachePipeline({ match, groupBy, limit }) {
  const id = groupId(groupBy);
  return [
    { $match: { ...match, 'promptCache.verdict': { $in: [...VERDICTS] } } },
    {
      $facet: {
        totals: [{ $group: { _id: null, ...accumulators() } }],
        groups: [
          { $group: { _id: id, ...accumulators() } },
          { $sort: { lostPrefillMs: -1, calls: -1 } },
          { $limit: limit + 1 },
        ],
        interleavers: [
          { $match: { 'promptCache.verdict': 'interleaved' } },
          { $unwind: '$promptCache.interleavedBy' },
          {
            $group: {
              _id: {
                group: id,
                kind: '$promptCache.interleavedBy.kind',
                consumerContract: '$promptCache.interleavedBy.consumerContract',
                taskType: '$promptCache.interleavedBy.taskType',
              },
              calls: { $sum: 1 },
            }
          },
          { $sort: { calls: -1 } },
        ],
      }
    },
  ];
}

const LABEL_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;
const labelOrNull = value => (typeof value === 'string' && LABEL_PATTERN.test(value) ? value : null);

function shapeStats(row) {
  const verdicts = {};
  for (const verdict of VERDICTS) verdicts[verdict] = row[`verdict__${verdict}`] || 0;
  const promptEvalMs = row.promptEvalMs || 0;
  return {
    calls: row.calls || 0,
    verdicts,
    chars: row.chars || 0,
    lostChars: row.lostChars || 0,
    lostPrefillMs: row.lostPrefillMs || 0,
    promptEvalMs,
    lostPrefillShare: promptEvalMs > 0 ? Math.round(((row.lostPrefillMs || 0) / promptEvalMs) * 1000) / 1000 : null,
  };
}

function shapePromptCache(facet, { groupBy, limit, sanitizeLabel }) {
  const keyOf = id => JSON.stringify(groupBy.map(field => id?.[field] ?? null));
  const interleaversByGroup = new Map();
  for (const row of Array.isArray(facet?.interleavers) ? facet.interleavers : []) {
    const key = keyOf(row._id?.group);
    const list = interleaversByGroup.get(key) || [];
    if (list.length < TOP_INTERLEAVERS) {
      list.push({
        kind: labelOrNull(row._id?.kind) || 'other',
        consumerContract: labelOrNull(row._id?.consumerContract),
        taskType: labelOrNull(row._id?.taskType),
        calls: row.calls || 0,
      });
    }
    interleaversByGroup.set(key, list);
  }
  const groupRows = Array.isArray(facet?.groups) ? facet.groups : [];
  return {
    groupBy,
    verdicts: VERDICT_DESCRIPTIONS,
    totals: shapeStats(facet?.totals?.[0] || {}),
    groups: groupRows.slice(0, limit).map(row => {
      const key = {};
      for (const field of groupBy) key[field] = sanitizeLabel(field, row._id?.[field]);
      return { key, ...shapeStats(row), interleavedBy: interleaversByGroup.get(keyOf(row._id)) || [] };
    }),
    truncated: groupRows.length > limit,
  };
}

module.exports = {
  DEFAULT_GROUP_BY,
  VERDICT_DESCRIPTIONS,
  buildPromptCachePipeline,
  parsePromptCacheGroupBy,
  shapePromptCache,
};
