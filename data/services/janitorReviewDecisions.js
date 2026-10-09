/**
 * Stored duplicate-review decisions: what the owner intends for one verified
 * duplicate group of the shared-drive strategy report.
 *
 * INTENT ONLY. A decision is a note of what the owner wants ("keep every copy",
 * "keep this one copy", "decide later"). This module reads and writes its own
 * collection and reads the file index. It never touches a shared-drive path,
 * never writes to `janitor_runs`, and is not consulted by
 * `janitorRunner.approveAction`: the only path that deletes a file still needs
 * a profile run action, a fresh SHA-256 preview, the typed confirmations and
 * JANITOR_EXECUTION_ENABLED=true. A stored `dedupe` decision is none of those
 * and cannot stand in for any of them.
 *
 * Identity: one decision per content hash. A duplicate group IS "every current
 * file with this SHA-256", so the hash is the only thing that stays the same
 * from one nightly report to the next. The file size and the paths seen are
 * kept as evidence, and a decision whose evidence no longer matches is reported
 * stale instead of being applied to a group that changed shape.
 */
const rules = require('../../shared/janitorReviewDecisionRules');
const { SHARED_ROOTS } = require('./janitorStrategyPolicy');
const { selectSurvivor } = require('./janitorStrategyDuplicates');

const COLLECTION = 'janitor_review_decisions';
// Staleness is computed, not stored. One request checks at most this many
// decisions (newest first) and says so when more exist.
const EVALUATION_MAX = 2000;
// One index lookup covers at most this many paths.
const INDEX_LOOKUP_PATHS = 2000;
const REPORT_DECISIONS_MAX = 100000;
const REASON_PATHS_SHOWN = 3;

const STALE_REASONS = Object.freeze({
  group_not_verified: 'This content is no longer a verified duplicate group: fewer than two current copies carry this hash.',
  size_changed: 'The file size recorded for this hash changed.',
  path_missing: 'A copy seen when deciding is no longer in the group.',
  hash_changed: 'A copy seen when deciding now has other content, or its hash is no longer current.',
  new_copies: 'Copies appeared that were not there when deciding.',
  survivor_missing: 'The copy chosen to survive is no longer in the group.'
});

function validationFailure(errors) {
  return { ok: false, badRequest: true, errors };
}

function publicDecision(doc) {
  if (!doc) return null;
  return {
    sha256: doc._id,
    decision: doc.decision,
    survivorPath: doc.survivorPath ?? null,
    note: doc.note ?? null,
    source: doc.source || 'toolbox',
    decidedAt: doc.decidedAt || null,
    evidence: {
      size: doc.evidence?.size ?? null,
      paths: Array.isArray(doc.evidence?.paths) ? doc.evidence.paths : [],
      reportId: doc.evidence?.reportId ?? null,
      reportGeneratedAt: doc.evidence?.reportGeneratedAt ?? null
    },
    // Repeated on every decision so no reader mistakes it for an approval.
    authorizesFilesystemMutation: false
  };
}

function storedFields(value, now) {
  return {
    decision: value.decision,
    survivorPath: value.survivorPath,
    note: value.note,
    source: value.source,
    decidedAt: now,
    evidence: value.evidence,
    authorizesFilesystemMutation: false
  };
}

async function upsertDecision(db, sha256, body, { now = new Date() } = {}) {
  const checked = rules.checkDecision(body, { roots: SHARED_ROOTS, sha256 });
  if (checked.errors.length) return validationFailure(checked.errors);
  const result = await db.collection(COLLECTION).updateOne(
    { _id: checked.value.sha256 },
    { $set: storedFields(checked.value, now), $setOnInsert: { createdAt: now } },
    { upsert: true }
  );
  const doc = await db.collection(COLLECTION).findOne({ _id: checked.value.sha256 });
  return { ok: true, created: Number(result.upsertedCount || 0) > 0, decision: publicDecision(doc) };
}

/**
 * Store a bounded batch. `mode: 'insert_missing'` never replaces a decision
 * already stored (used to import a browser draft); `upsert` replaces.
 */
async function upsertBatch(db, body, { now = new Date() } = {}) {
  const checked = rules.checkBatch(body, { roots: SHARED_ROOTS });
  if (checked.errors.length) return validationFailure(checked.errors);
  const { mode, decisions } = checked.value;
  const operations = decisions.map((value) => ({
    updateOne: {
      filter: { _id: value.sha256 },
      update: mode === 'insert_missing'
        ? { $setOnInsert: { ...storedFields(value, now), createdAt: now } }
        : { $set: storedFields(value, now), $setOnInsert: { createdAt: now } },
      upsert: true
    }
  }));
  const result = await db.collection(COLLECTION).bulkWrite(operations, { ordered: false });
  const inserted = new Set(Object.keys(result.upsertedIds || {}).map((index) => decisions[Number(index)].sha256));
  const saved = [];
  const skipped = [];
  for (const value of decisions) {
    if (mode === 'insert_missing' && !inserted.has(value.sha256)) skipped.push(value.sha256);
    else saved.push(value.sha256);
  }
  return { ok: true, mode, saved, skipped, created: inserted.size };
}

async function removeDecision(db, sha256) {
  if (!rules.isSha256(sha256)) return validationFailure(['sha256 must be 64 lowercase hexadecimal characters']);
  const result = await db.collection(COLLECTION).deleteOne({ _id: sha256 });
  if (!result.deletedCount) return { ok: false, notFound: true };
  return { ok: true, deleted: sha256 };
}

function reason(code, paths = []) {
  const entry = { code, detail: STALE_REASONS[code] };
  if (paths.length) {
    entry.count = paths.length;
    entry.paths = paths.slice(0, REASON_PATHS_SHOWN);
  }
  return entry;
}

/**
 * Compare a decision with the group as it is now. `group` is
 * `{ size, files: [{ path }] }` or null when no group carries the hash.
 * `pathStates` (index lookups only) maps a path to `{ exists, sha256, current }`
 * so a copy that changed content is told apart from one that is gone.
 *
 * Returns `{ state: 'current' | 'stale', reasons }`. Never changes anything.
 */
function evaluateDecision(decision, group, { pathStates = null } = {}) {
  const decided = Array.isArray(decision?.evidence?.paths) ? decision.evidence.paths : [];
  const currentPaths = (group?.files || []).map((file) => file?.path).filter(Boolean);
  const current = new Set(currentPaths);
  const reasons = [];

  if (currentPaths.length < 2) reasons.push(reason('group_not_verified'));
  if (group && currentPaths.length && Number(group.size) !== Number(decision.evidence?.size)) reasons.push(reason('size_changed'));

  const missing = decided.filter((value) => !current.has(value));
  const changed = pathStates
    ? missing.filter((value) => pathStates.get(value)?.exists)
    : [];
  const gone = missing.filter((value) => !changed.includes(value));
  if (gone.length) reasons.push(reason('path_missing', gone));
  if (changed.length) reasons.push(reason('hash_changed', changed));

  const decidedSet = new Set(decided);
  const added = currentPaths.filter((value) => !decidedSet.has(value));
  if (added.length) reasons.push(reason('new_copies', added));

  if (decision.decision === 'dedupe' && !current.has(decision.survivorPath)) {
    reasons.push(reason('survivor_missing', decision.survivorPath ? [decision.survivorPath] : []));
  }
  return { state: reasons.length ? 'stale' : 'current', reasons };
}

function underSharedRoot(value) {
  return SHARED_ROOTS.some((root) => value.startsWith(`${root}/`));
}

// The same test as the strategy report's verified groups: a hash that still
// matches the file's size and date, under a shared root, outside key stores.
function isCurrentMember(file) {
  return !!file.sha256
    && Number(file.size) > 0
    && file.hash_fingerprint === `${Number(file.size || 0)}:${Number(file.mtime || 0)}`
    && typeof file.path === 'string'
    && underSharedRoot(file.path)
    && !/\/keys\//.test(file.path);
}

/**
 * Read the file index for a set of decisions and return, per hash, the group
 * as it is now plus what became of each path seen when deciding. Read-only.
 */
async function currentEvidenceFromIndex(db, decisions) {
  const result = new Map();
  const files = db.collection('nas_files');
  let batch = [];
  let batchPaths = 0;
  const flush = async () => {
    if (!batch.length) return;
    const shas = batch.map((decision) => decision.sha256);
    const paths = batch.flatMap((decision) => decision.evidence.paths);
    const rows = await files.find(
      { $or: [{ sha256: { $in: shas } }, { path: { $in: paths } }] },
      { projection: { _id: 0, path: 1, sha256: 1, size: 1, mtime: 1, hash_fingerprint: 1, storage_role: 1 } }
    ).toArray();
    const byPath = new Map(rows.map((row) => [row.path, row]));
    for (const decision of batch) {
      const members = rows.filter((row) => row.sha256 === decision.sha256 && isCurrentMember(row));
      const pathStates = new Map(decision.evidence.paths.map((value) => {
        const row = byPath.get(value);
        return [value, { exists: !!row, sha256: row?.sha256 ?? null, current: row ? isCurrentMember(row) : false }];
      }));
      result.set(decision.sha256, {
        group: members.length
          ? { size: Number(members[0].size), files: members.map((row) => ({ path: row.path, mtime: row.mtime ?? null, storageRole: row.storage_role || null })) }
          : null,
        pathStates
      });
    }
    batch = [];
    batchPaths = 0;
  };
  for (const decision of decisions) {
    if (batch.length && batchPaths + decision.evidence.paths.length > INDEX_LOOKUP_PATHS) await flush();
    batch.push(decision);
    batchPaths += decision.evidence.paths.length;
  }
  await flush();
  return result;
}

function policySurvivorPath(group, policy) {
  const rule = policy?.duplicateSurvivor;
  if (!rule) return null;
  const files = (group?.files || []).filter((file) => file?.path);
  return files.length > 1 ? selectSurvivor(files, rule)?.path || null : null;
}

/**
 * The read-only mark shown next to a group: the decision, whether it still
 * fits the group, and how the owner's survivor compares with the policy's.
 * The policy's survivor is computed exactly as the report does; both are
 * returned, neither replaces the other.
 */
function buildMark(decision, group, policy, evaluation, reference) {
  const fromPolicy = policySurvivorPath(group, policy);
  return {
    decision: decision.decision,
    survivorPath: decision.survivorPath,
    note: decision.note,
    decidedAt: decision.decidedAt,
    state: evaluation.state,
    staleReasons: evaluation.reasons,
    reference,
    policySurvivorPath: fromPolicy,
    survivorDiffersFromPolicy: decision.decision === 'dedupe' && !!fromPolicy && fromPolicy !== decision.survivorPath,
    authorizesFilesystemMutation: false
  };
}

/**
 * Counts for a set of evaluated decisions. `reclaimableBytes` only counts
 * `dedupe` decisions that still fit their group: (copies - 1) x file size.
 * It is what the owner's intent represents, not space that was or will be freed
 * by storing it.
 */
function summarize(entries, { reference, total = entries.length, truncated = false, asOf = new Date() } = {}) {
  const summary = {
    asOf,
    reference,
    authorizesFilesystemMutation: false,
    total,
    evaluated: entries.length,
    truncated,
    byDecision: { keep_all: 0, dedupe: 0, defer: 0 },
    current: 0,
    stale: 0,
    staleByReason: {},
    dedupe: { current: 0, stale: 0, reclaimableBytes: 0, survivorDiffersFromPolicy: 0 }
  };
  for (const { decision, evaluation, group, mark } of entries) {
    if (summary.byDecision[decision.decision] !== undefined) summary.byDecision[decision.decision] += 1;
    summary[evaluation.state] += 1;
    for (const entry of evaluation.reasons) summary.staleByReason[entry.code] = (summary.staleByReason[entry.code] || 0) + 1;
    if (decision.decision !== 'dedupe') continue;
    summary.dedupe[evaluation.state] += 1;
    if (evaluation.state !== 'current') continue;
    summary.dedupe.reclaimableBytes += Number(group.size) * Math.max(0, group.files.length - 1);
    if (mark?.survivorDiffersFromPolicy) summary.dedupe.survivorDiffersFromPolicy += 1;
  }
  return summary;
}

async function countsByDecision(db) {
  const rows = await db.collection(COLLECTION).aggregate([{ $group: { _id: '$decision', count: { $sum: 1 } } }]).toArray();
  const counts = { keep_all: 0, dedupe: 0, defer: 0 };
  for (const row of rows) if (counts[row._id] !== undefined) counts[row._id] = row.count;
  return counts;
}

async function evaluateAgainstIndex(db, docs, policy) {
  const decisions = docs.map(publicDecision);
  const evidence = await currentEvidenceFromIndex(db, decisions);
  return decisions.map((decision) => {
    const { group, pathStates } = evidence.get(decision.sha256) || { group: null, pathStates: null };
    const evaluation = evaluateDecision(decision, group, { pathStates });
    return { decision, evaluation, group, mark: buildMark(decision, group, policy, evaluation, 'file-index') };
  });
}

function escapeRegex(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * List stored decisions, newest first, each with its state against the file
 * index as it is now. Bounded: at most EVALUATION_MAX decisions are checked for
 * staleness per request, and `truncated` says when more matched.
 */
async function listDecisions(db, query, { policy = null } = {}) {
  const checked = rules.checkListQuery(query, { roots: SHARED_ROOTS });
  if (checked.errors.length) return validationFailure(checked.errors);
  const { decision, state, pathPrefix, sha256, limit, offset } = checked.value;
  const collection = db.collection(COLLECTION);

  const filter = {};
  if (decision) filter.decision = decision;
  if (sha256) filter._id = { $in: sha256 };
  if (pathPrefix) filter['evidence.paths'] = { $regex: `^${escapeRegex(pathPrefix)}/` };
  const filtered = Object.keys(filter).length > 0;

  const [total, byDecision, matched, newest] = await Promise.all([
    collection.countDocuments({}),
    countsByDecision(db),
    filtered ? collection.countDocuments(filter) : null,
    collection.find({}).sort({ decidedAt: -1, _id: 1 }).limit(EVALUATION_MAX).toArray()
  ]);
  const everything = await evaluateAgainstIndex(db, newest, policy);
  const summary = summarize(everything, { reference: 'file-index', total, truncated: total > newest.length });
  // Exact counts for the whole collection; the rest covers the decisions evaluated.
  summary.byDecision = byDecision;

  let entries = everything;
  let matchedTotal = total;
  if (filtered) {
    const docs = await collection.find(filter).sort({ decidedAt: -1, _id: 1 }).limit(EVALUATION_MAX).toArray();
    entries = await evaluateAgainstIndex(db, docs, policy);
    matchedTotal = matched;
  }
  const evaluatedAll = matchedTotal <= entries.length;
  if (state) entries = entries.filter((entry) => entry.evaluation.state === state);

  return {
    ok: true,
    decisions: entries.slice(offset, offset + limit).map(({ decision: stored, mark }) => ({
      ...stored,
      state: mark.state,
      staleReasons: mark.staleReasons,
      policySurvivorPath: mark.policySurvivorPath,
      survivorDiffersFromPolicy: mark.survivorDiffersFromPolicy
    })),
    pagination: {
      // With a state filter the total is the number found among the decisions
      // evaluated; `complete` is false when more matched than were evaluated.
      total: state ? entries.length : matchedTotal,
      offset,
      limit,
      complete: evaluatedAll
    },
    summary
  };
}

/** Mark report groups (`{ sha256, size, files }`) with their stored decision. Read-only. */
async function markGroups(db, groups, policy) {
  const shas = groups.map((group) => group.sha256).filter(rules.isSha256);
  const docs = shas.length ? await db.collection(COLLECTION).find({ _id: { $in: shas } }).toArray() : [];
  const bySha = new Map(docs.map((doc) => [doc._id, publicDecision(doc)]));
  return groups.map((group) => {
    const decision = bySha.get(group.sha256);
    const marked = { ...group, policySurvivorPath: policySurvivorPath(group, policy), review: null };
    if (decision) marked.review = buildMark(decision, group, policy, evaluateDecision(decision, group), 'report-group');
    return marked;
  });
}

async function decidedShas(db, shas) {
  const valid = shas.filter(rules.isSha256);
  if (!valid.length) return new Set();
  const docs = await db.collection(COLLECTION).find({ _id: { $in: valid } }, { projection: { _id: 1 } }).toArray();
  return new Set(docs.map((doc) => doc._id));
}

/**
 * What the stored decisions amount to against one report's verified groups:
 * counts by decision, how many still fit, and the bytes the `dedupe` ones
 * represent. Computed from the groups as the report lists them; it changes
 * neither which groups are verified nor the survivor the policy selects.
 */
function summarizeForReport(docs, groups, policy, { total = docs.length, asOf = new Date() } = {}) {
  const bySha = new Map((groups || []).map((group) => [group.sha256, group]));
  const marks = new Map();
  let notInReport = 0;
  const entries = docs.map((doc) => {
    const decision = publicDecision(doc);
    const group = bySha.get(decision.sha256) || null;
    if (!group) notInReport += 1;
    const evaluation = evaluateDecision(decision, group);
    const mark = buildMark(decision, group, policy, evaluation, 'report-group');
    if (group) marks.set(decision.sha256, mark);
    return { decision, evaluation, group, mark };
  });
  const summary = summarize(entries, { reference: 'report-groups', total, truncated: total > docs.length, asOf });
  summary.inReport = entries.length - notInReport;
  summary.notInReport = notInReport;
  return { summary, marks };
}

async function loadForReport(db) {
  const collection = db.collection(COLLECTION);
  const [total, docs] = await Promise.all([
    collection.countDocuments({}),
    collection.find({}).sort({ decidedAt: -1, _id: 1 }).limit(REPORT_DECISIONS_MAX).toArray()
  ]);
  return { total, docs };
}

/** The summary a new strategy report stores: the decisions as they stood when it was generated. */
async function reportSummary(db, report) {
  try {
    const { total, docs } = await loadForReport(db);
    const groups = report?.evidence?.verifiedDuplicateEvidence || [];
    return summarizeForReport(docs, groups, report?.policy, { total, asOf: report?.generatedAt || new Date() }).summary;
  } catch (error) {
    // A report must still be generated when the decisions cannot be read.
    return { status: 'unavailable', message: error.message, authorizesFilesystemMutation: false };
  }
}

/**
 * Add the decisions to a hydrated report on its way out: a `review` mark on
 * each group that has one, and `reviewDecisions` as they stand now (the
 * summary stored at generation moves to `reviewDecisions.atGeneration`).
 * Returns a new object; the stored report and its groups are not rewritten.
 */
async function annotateStrategyReport(db, report) {
  if (!report?.evidence) return report;
  const atGeneration = report.reviewDecisions || null;
  try {
    const { total, docs } = await loadForReport(db);
    const groups = Array.isArray(report.evidence.verifiedDuplicateEvidence) ? report.evidence.verifiedDuplicateEvidence : [];
    const { summary, marks } = summarizeForReport(docs, groups, report.policy, { total });
    return {
      ...report,
      evidence: {
        ...report.evidence,
        verifiedDuplicateEvidence: groups.map((group) => (marks.has(group.sha256) ? { ...group, review: marks.get(group.sha256) } : group))
      },
      reviewDecisions: { ...summary, atGeneration }
    };
  } catch (error) {
    return { ...report, reviewDecisions: { status: 'unavailable', message: error.message, authorizesFilesystemMutation: false, atGeneration } };
  }
}

module.exports = {
  COLLECTION,
  EVALUATION_MAX,
  STALE_REASONS,
  publicDecision,
  upsertDecision,
  upsertBatch,
  removeDecision,
  evaluateDecision,
  currentEvidenceFromIndex,
  policySurvivorPath,
  buildMark,
  summarize,
  summarizeForReport,
  listDecisions,
  markGroups,
  decidedShas,
  reportSummary,
  annotateStrategyReport
};
