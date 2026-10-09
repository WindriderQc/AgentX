'use strict';

/**
 * Toolbox relay for the Janitor duplicate review: stored review decisions (one
 * write family, `janitor-review-decision`) and the paged read of the latest
 * report's verified groups.
 *
 * A decision records the owner's intent for one duplicate group. These routes
 * reach Data's review-decision routes only: nothing here calls a preview, an
 * approval or any route that changes a file. Every body is checked with the
 * rules Data applies (shared/janitorReviewDecisionRules) before it is forwarded,
 * and only the checked fields are sent.
 */
const rules = require('../../../shared/janitorReviewDecisionRules');

const DATA_BASE = '/api/v1/janitor/profiles/shared-drive';
const GROUP_PAGE_DEFAULT = 30;
const GROUP_PAGE_MAX = 50;
const GROUP_OFFSET_MAX = 10000000;
// A page row lists at most this many copies; a larger group is shown as
// incomplete and cannot be decided from the page.
const GROUP_FILE_LIMIT = 60;
const REASON_LIMIT = 8;
const GROUP_REVIEW_FILTERS = Object.freeze(['all', 'undecided']);

const text = (value, max = 1100) => (typeof value === 'string' ? value.slice(0, max) : null);
const count = (value) => (Number.isFinite(Number(value)) && value !== null && value !== '' ? Number(value) : null);

function refuse(res, code, errors) {
  return res.status(400).json({ ok: false, status: 'error', code, message: errors.slice(0, 5).join('; '), errors: errors.slice(0, 20) });
}

function unavailable(res, error, uncertain = '') {
  const timedOut = error.name === 'TimeoutError';
  return res.status(502).json({
    ok: false,
    status: 'error',
    code: timedOut ? 'DATA_TIMEOUT' : 'DATA_UNAVAILABLE',
    message: timedOut ? `Data did not answer in time${uncertain}` : error.message
  });
}

/** The bounded mark shown next to a group; null when the group has no decision. */
function projectReview(review) {
  if (!review || typeof review !== 'object') return null;
  return {
    decision: rules.DECISIONS.includes(review.decision) ? review.decision : null,
    survivorPath: text(review.survivorPath),
    note: text(review.note, rules.LIMITS.noteLength),
    decidedAt: review.decidedAt || null,
    state: review.state === 'stale' ? 'stale' : 'current',
    staleReasons: (Array.isArray(review.staleReasons) ? review.staleReasons : []).slice(0, REASON_LIMIT).map((reason) => ({
      code: text(reason?.code, 60),
      detail: text(reason?.detail, 300),
      count: count(reason?.count),
      paths: (Array.isArray(reason?.paths) ? reason.paths : []).slice(0, 3).map((value) => text(value))
    })),
    policySurvivorPath: text(review.policySurvivorPath),
    survivorDiffersFromPolicy: review.survivorDiffersFromPolicy === true,
    authorizesFilesystemMutation: false
  };
}

/** The report's own count of the stored decisions, as numbers only. */
function projectReviewSummary(summary) {
  if (!summary || typeof summary !== 'object' || summary.status === 'unavailable') return null;
  return {
    asOf: summary.asOf || null,
    total: count(summary.total),
    byDecision: {
      keep_all: count(summary.byDecision?.keep_all),
      dedupe: count(summary.byDecision?.dedupe),
      defer: count(summary.byDecision?.defer)
    },
    current: count(summary.current),
    stale: count(summary.stale),
    reclaimableBytes: count(summary.dedupe?.reclaimableBytes),
    survivorDiffersFromPolicy: count(summary.dedupe?.survivorDiffersFromPolicy),
    authorizesFilesystemMutation: false
  };
}

/** One page of verified groups, bounded for the browser. */
function projectGroupsPage(body) {
  const page = body?.data ?? body ?? {};
  const groups = Array.isArray(page.groups) ? page.groups.slice(0, GROUP_PAGE_MAX) : [];
  return {
    report: {
      id: text(page.report?.id, 40),
      generatedAt: page.report?.generatedAt || null,
      status: text(page.report?.status, 60),
      duplicateSurvivorRule: text(page.report?.duplicateSurvivorRule, 60)
    },
    total: count(page.total),
    offset: count(page.offset) ?? 0,
    limit: count(page.limit) ?? GROUP_PAGE_DEFAULT,
    review: GROUP_REVIEW_FILTERS.includes(page.review) ? page.review : 'all',
    scanned: count(page.scanned),
    scanBoundReached: page.scanBoundReached === true,
    nextOffset: count(page.nextOffset),
    groups: groups.map((group) => {
      const files = Array.isArray(group.files) ? group.files : [];
      return {
        sha256: text(group.sha256, 128),
        position: count(group.position),
        proof: text(group.proof, 60),
        size: count(group.size),
        count: count(group.count) ?? files.length,
        provenSavingsBytes: count(group.provenSavingsBytes),
        files: files.slice(0, GROUP_FILE_LIMIT).map((file) => ({
          path: text(file?.path),
          mtime: file?.mtime ?? null,
          storageRole: text(file?.storageRole, 60)
        })),
        filesOmitted: Math.max(0, files.length - GROUP_FILE_LIMIT),
        policySurvivorPath: text(group.policySurvivorPath),
        review: projectReview(group.review)
      };
    })
  };
}

/** The filters of a groups page: whole numbers within bounds and a known review filter. */
function checkGroupsQuery(query = {}) {
  const errors = Object.keys(query).filter((key) => !['offset', 'limit', 'review', 'sha256'].includes(key)).slice(0, 5)
    .map((key) => `unknown query field ${JSON.stringify(key.slice(0, 40))}`);
  const whole = (name, fallback, min, max) => {
    const raw = Array.isArray(query[name]) ? query[name][0] : query[name];
    if (raw === undefined || raw === '') return fallback;
    if (!/^\d{1,9}$/.test(String(raw)) || Number(raw) < min || Number(raw) > max) {
      errors.push(`${name} must be a whole number from ${min} to ${max}`);
      return fallback;
    }
    return Number(raw);
  };
  const value = { offset: whole('offset', 0, 0, GROUP_OFFSET_MAX), limit: whole('limit', GROUP_PAGE_DEFAULT, 1, GROUP_PAGE_MAX), review: 'all' };
  // Named groups instead of a position (the import of a browser draft looks them up).
  const named = Array.isArray(query.sha256) ? query.sha256[0] : query.sha256;
  if (named !== undefined && named !== '') {
    const list = String(named).split(',');
    if (list.length > GROUP_PAGE_MAX || !list.every(rules.isSha256)) errors.push(`sha256 must be at most ${GROUP_PAGE_MAX} comma-separated SHA-256 values`);
    else value.sha256 = [...new Set(list)].join(',');
  }
  const review = Array.isArray(query.review) ? query.review[0] : query.review;
  if (review !== undefined && review !== '') {
    if (!GROUP_REVIEW_FILTERS.includes(review)) errors.push(`review must be one of ${GROUP_REVIEW_FILTERS.join(', ')}`);
    else value.review = review;
  }
  return errors.length ? { errors, value: null } : { errors, value };
}

// What Data receives for one decision: the checked fields, nothing else.
function decisionPayload(value, { withSha = false } = {}) {
  return {
    ...(withSha ? { sha256: value.sha256 } : {}),
    decision: value.decision,
    ...(value.decision === 'dedupe' ? { survivorPath: value.survivorPath } : {}),
    note: value.note,
    source: value.source,
    evidence: value.evidence
  };
}

function register(router, { fetchData }) {
  router.get('/janitor/strategy/latest/groups', async (req, res) => {
    const checked = checkGroupsQuery(req.query);
    if (checked.errors.length) return refuse(res, 'INVALID_GROUPS_PAGE', checked.errors);
    try {
      const query = new URLSearchParams(Object.entries(checked.value).map(([key, value]) => [key, String(value)])).toString();
      const { response, body } = await fetchData(`${DATA_BASE}/strategy/latest/groups`, { query });
      if (!response.ok) return res.status(response.status).json(body);
      return res.json({ ok: true, status: 'success', data: projectGroupsPage(body) });
    } catch (error) { return unavailable(res, error); }
  });

  router.get('/janitor/review-decisions', async (req, res) => {
    const checked = rules.checkListQuery(req.query);
    if (checked.errors.length) return refuse(res, 'INVALID_REVIEW_DECISION_QUERY', checked.errors);
    try {
      const query = new URLSearchParams();
      for (const [key, value] of Object.entries(checked.value)) {
        if (value !== null) query.set(key, Array.isArray(value) ? value.join(',') : String(value));
      }
      const { response, body } = await fetchData(`${DATA_BASE}/review-decisions`, { query: query.toString() });
      return res.status(response.status).json(body);
    } catch (error) { return unavailable(res, error); }
  });

  // The Janitor write family, 1 of 3: store or replace the decision of one group.
  router.put('/janitor/review-decisions/:sha256', async (req, res) => {
    const checked = rules.checkDecision(req.body, { sha256: String(req.params.sha256 || '') });
    if (checked.errors.length) return refuse(res, 'INVALID_REVIEW_DECISION', checked.errors);
    try {
      const { response, body } = await fetchData(`${DATA_BASE}/review-decisions/${checked.value.sha256}`,
        { method: 'PUT', payload: decisionPayload(checked.value) });
      return res.status(response.status).json(body);
    } catch (error) { return unavailable(res, error, ': the decision may or may not have been saved'); }
  });

  // 2 of 3: store a bounded batch (the import of a browser draft).
  router.post('/janitor/review-decisions/batch', async (req, res) => {
    const checked = rules.checkBatch(req.body);
    if (checked.errors.length) return refuse(res, 'INVALID_REVIEW_DECISION_BATCH', checked.errors);
    try {
      const payload = { mode: checked.value.mode, decisions: checked.value.decisions.map((value) => decisionPayload(value, { withSha: true })) };
      const { response, body } = await fetchData(`${DATA_BASE}/review-decisions/batch`, { method: 'POST', payload });
      return res.status(response.status).json(body);
    } catch (error) { return unavailable(res, error, ': the decisions may or may not have been saved'); }
  });

  // 3 of 3: remove the stored decision of one group (undo). It deletes a
  // record of intent in Data's database, never a file.
  router.delete('/janitor/review-decisions/:sha256', async (req, res) => {
    const sha256 = String(req.params.sha256 || '');
    if (!rules.isSha256(sha256)) return refuse(res, 'INVALID_REVIEW_DECISION', ['sha256 must be 64 lowercase hexadecimal characters']);
    try {
      const { response, body } = await fetchData(`${DATA_BASE}/review-decisions/${sha256}`, { method: 'DELETE' });
      return res.status(response.status).json(body);
    } catch (error) { return unavailable(res, error, ': the decision may or may not have been removed'); }
  });
}

module.exports = {
  GROUP_PAGE_DEFAULT,
  GROUP_PAGE_MAX,
  GROUP_FILE_LIMIT,
  register,
  checkGroupsQuery,
  projectGroupsPage,
  projectReview,
  projectReviewSummary
};
