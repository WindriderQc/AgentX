/**
 * Bounded, paged read of the latest strategy report's verified duplicate
 * groups. The report keeps its groups in chunk documents
 * (`janitor_strategy_report_details`, at most 100 groups or 4 MiB each); this
 * reads only the chunks a page needs instead of hydrating the whole report.
 * Read-only: it marks each group with its stored review decision and changes
 * nothing.
 */
const { REPORT_COLLECTION, REPORT_DETAIL_COLLECTION } = require('./janitorStrategyReportStore');
const reviewDecisions = require('./janitorReviewDecisions');

const PAGE_LIMIT_DEFAULT = 30;
const PAGE_LIMIT_MAX = 50;
const OFFSET_MAX = 10000000;
// With the "undecided" filter a page may have to skip decided groups: it reads
// at most this many chunks, then returns what it found and where to resume.
const CHUNK_SCAN_MAX = 10;
const REVIEW_FILTERS = Object.freeze(['all', 'undecided']);
const QUERY_KEYS = Object.freeze(['offset', 'limit', 'review', 'sha256']);
const SHA256 = /^[0-9a-f]{64}$/;

function checkPageQuery(query = {}) {
  const errors = Object.keys(query).filter((key) => !QUERY_KEYS.includes(key)).slice(0, 5)
    .map((key) => `unknown query field ${JSON.stringify(key.slice(0, 40))}`);
  const one = (name) => (Array.isArray(query[name]) ? query[name][0] : query[name]);
  const whole = (name, fallback, min, max) => {
    const raw = one(name);
    if (raw === undefined || raw === '') return fallback;
    if (!/^\d{1,9}$/.test(String(raw)) || Number(raw) < min || Number(raw) > max) {
      errors.push(`${name} must be a whole number from ${min} to ${max}`);
      return fallback;
    }
    return Number(raw);
  };
  const value = {
    offset: whole('offset', 0, 0, OFFSET_MAX),
    limit: whole('limit', PAGE_LIMIT_DEFAULT, 1, PAGE_LIMIT_MAX),
    review: 'all',
    sha256: null
  };
  // Named groups instead of a position: at most one page of hashes.
  const named = one('sha256');
  if (named !== undefined && named !== '') {
    const list = String(named).split(',');
    if (list.length > PAGE_LIMIT_MAX || !list.every((value) => SHA256.test(value))) {
      errors.push(`sha256 must be at most ${PAGE_LIMIT_MAX} comma-separated SHA-256 values`);
    } else value.sha256 = [...new Set(list)];
  }
  const review = one('review');
  if (review !== undefined && review !== '') {
    if (!REVIEW_FILTERS.includes(review)) errors.push(`review must be one of ${REVIEW_FILTERS.join(', ')}`);
    else value.review = review;
  }
  return errors.length ? { errors, value: null } : { errors, value };
}

async function chunkSizes(db, report) {
  const rows = await db.collection(REPORT_DETAIL_COLLECTION).aggregate([
    { $match: { reportId: report._id } },
    { $sort: { ordinal: 1 } },
    { $project: { _id: 0, ordinal: 1, groups: { $size: { $ifNull: ['$groups', []] } } } }
  ]).toArray();
  const expected = Math.max(0, Number(report.detailStorage.chunks || 0));
  if (rows.length !== expected) {
    throw new Error(`Janitor strategy detail evidence is incomplete: expected ${expected} chunks, found ${rows.length}`);
  }
  return rows;
}

/**
 * One page of the latest report's verified groups, in the report's own order.
 * `offset` is a position in that order; `nextOffset` is where the next page
 * starts (null at the end). Returns null when no report exists.
 */
async function latestGroupsPage(db, query) {
  const checked = checkPageQuery(query);
  if (checked.errors.length) return { ok: false, badRequest: true, errors: checked.errors };
  const { offset, limit, review, sha256 } = checked.value;

  const report = await db.collection(REPORT_COLLECTION).findOne({}, {
    sort: { generatedAt: -1 },
    projection: { generatedAt: 1, status: 1, policy: 1, detailStorage: 1 }
  });
  if (!report) return { ok: false, notFound: true };
  if (!report.detailStorage) {
    return { ok: false, conflict: true, error: 'The latest strategy report predates chunked group storage; generate a new report to page through its groups.' };
  }

  const summary = {
    id: String(report._id),
    generatedAt: report.generatedAt || null,
    status: report.status || null,
    duplicateSurvivorRule: report.policy?.duplicateSurvivor || null
  };
  if (sha256) {
    // Find named groups wherever they sit in the report. `position` is not known this way.
    const found = await db.collection(REPORT_DETAIL_COLLECTION).aggregate([
      { $match: { reportId: report._id, 'groups.sha256': { $in: sha256 } } },
      { $unwind: '$groups' },
      { $match: { 'groups.sha256': { $in: sha256 } } },
      { $limit: sha256.length },
      { $replaceRoot: { newRoot: '$groups' } }
    ]).toArray();
    return {
      ok: true,
      report: summary,
      total: Math.max(0, Number(report.detailStorage.verifiedDuplicateGroups || 0)),
      offset: 0,
      limit: sha256.length,
      review: 'all',
      lookup: 'sha256',
      scanned: found.length,
      scanBoundReached: false,
      nextOffset: null,
      groups: await reviewDecisions.markGroups(db, found.map((group) => ({ ...group, position: null })), report.policy)
    };
  }

  const sizes = await chunkSizes(db, report);
  const total = sizes.reduce((sum, row) => sum + row.groups, 0);
  const collected = [];
  let position = 0;
  let cursor = Math.min(offset, total);
  let chunksRead = 0;
  let scanned = 0;

  for (const row of sizes) {
    const chunkStart = position;
    position += row.groups;
    if (position <= cursor || !row.groups) continue;
    if (collected.length >= limit || chunksRead >= CHUNK_SCAN_MAX) break;
    const chunk = await db.collection(REPORT_DETAIL_COLLECTION).findOne({ reportId: report._id, ordinal: row.ordinal });
    chunksRead += 1;
    const groups = Array.isArray(chunk?.groups) ? chunk.groups : [];
    const candidates = groups.map((group, index) => ({ ...group, position: chunkStart + index })).filter((group) => group.position >= cursor);
    const decided = review === 'undecided'
      ? await reviewDecisions.decidedShas(db, candidates.map((group) => group.sha256))
      : new Set();
    for (const group of candidates) {
      if (collected.length >= limit) break;
      cursor = group.position + 1;
      scanned += 1;
      if (!decided.has(group.sha256)) collected.push(group);
    }
  }

  return {
    ok: true,
    report: summary,
    total,
    offset: Math.min(offset, total),
    limit,
    review,
    scanned,
    // True when the undecided filter stopped at its read bound before filling the page.
    scanBoundReached: collected.length < limit && cursor < total,
    nextOffset: cursor < total ? cursor : null,
    groups: await reviewDecisions.markGroups(db, collected, report.policy)
  };
}

module.exports = {
  PAGE_LIMIT_DEFAULT,
  PAGE_LIMIT_MAX,
  CHUNK_SCAN_MAX,
  checkPageQuery,
  latestGroupsPage
};
