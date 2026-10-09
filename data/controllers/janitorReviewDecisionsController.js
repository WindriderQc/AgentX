/**
 * HTTP handlers for stored duplicate-review decisions and the paged read of
 * the latest report's verified groups.
 *
 * None of these handlers approves, previews or executes a janitor action: they
 * call janitorReviewDecisions and janitorStrategyGroupPages only. The approval
 * route (`POST /runs/:run_id/actions/:idx/approve`) is unchanged and does not
 * read what is stored here.
 */
const janitorReviewDecisions = require('../services/janitorReviewDecisions');
const janitorStrategyGroupPages = require('../services/janitorStrategyGroupPages');
const janitorStrategyPolicy = require('../services/janitorStrategyPolicy');
const { log } = require('../utils/logger');

function refuse(res, result) {
  if (result.notFound) return res.status(404).json({ status: 'error', message: 'not found' });
  if (result.conflict) return res.status(409).json({ status: 'error', message: result.error });
  return res.status(400).json({ status: 'error', errors: result.errors });
}

function failed(res, name, err) {
  log(`[janitorReviewDecisions] ${name} error: ${err.message}`, 'error');
  res.status(500).json({ status: 'error', message: err.message });
}

const list = async (req, res) => {
  try {
    const db = req.app.locals.db;
    const policy = await janitorStrategyPolicy.getPolicy(db);
    const result = await janitorReviewDecisions.listDecisions(db, req.query, { policy });
    if (!result.ok) return refuse(res, result);
    const { ok: _ok, ...data } = result;
    res.json({ status: 'success', data });
  } catch (err) { failed(res, 'list', err); }
};

const put = async (req, res) => {
  try {
    const result = await janitorReviewDecisions.upsertDecision(req.app.locals.db, req.params.sha256, req.body);
    if (!result.ok) return refuse(res, result);
    res.status(result.created ? 201 : 200).json({ status: 'success', data: { decision: result.decision, created: result.created } });
  } catch (err) { failed(res, 'put', err); }
};

const batch = async (req, res) => {
  try {
    const result = await janitorReviewDecisions.upsertBatch(req.app.locals.db, req.body);
    if (!result.ok) return refuse(res, result);
    const { ok: _ok, ...data } = result;
    res.json({ status: 'success', data });
  } catch (err) { failed(res, 'batch', err); }
};

const remove = async (req, res) => {
  try {
    const result = await janitorReviewDecisions.removeDecision(req.app.locals.db, req.params.sha256);
    if (!result.ok) return refuse(res, result);
    res.json({ status: 'success', data: { deleted: result.deleted } });
  } catch (err) { failed(res, 'remove', err); }
};

const groupsPage = async (req, res) => {
  try {
    const result = await janitorStrategyGroupPages.latestGroupsPage(req.app.locals.db, req.query);
    if (!result.ok) {
      if (result.notFound) return res.status(404).json({ status: 'error', message: 'strategy report not found' });
      return refuse(res, result);
    }
    const { ok: _ok, ...data } = result;
    res.json({ status: 'success', data });
  } catch (err) { failed(res, 'groupsPage', err); }
};

module.exports = { list, put, batch, remove, groupsPage };
