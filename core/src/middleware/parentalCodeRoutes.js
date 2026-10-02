'use strict';

const path = require('node:path');
const logger = require('../../config/logger');
const { codeProblem } = require('../services/parentalCodeService');

// Setting and changing the parental code from the browser. These routes sit
// before the adult gate. The first code can only be set by a request that did
// not come through the household gateway, i.e. on the AgentX host itself.
function registerParentalCodeRoutes({ app, auth, code, isEntry, root }) {
  const json = (res, data) => res.set('Cache-Control', 'private, no-store').json({ ok: true, status: 'success', data });
  const fail = (res, status, errorCode, message) => res.status(status).set('Cache-Control', 'no-store')
    .json({ ok: false, status: 'error', code: errorCode, message });
  const newCodeProblem = body => codeProblem(body?.code)
    || (body.code !== body.confirm ? 'Les deux codes ne correspondent pas.' : null);
  const unavailable = (res, error) => {
    logger.warn('Parental code storage unavailable', { error: error.message });
    return fail(res, 503, 'ADULT_CODE_UNAVAILABLE', 'Le code parental est momentanément indisponible. Réessaie.');
  };
  const handle = fn => async (req, res) => {
    try { return await fn(req, res); } catch (error) { return unavailable(res, error); }
  };

  // Every route that reads the active code waits for the stored one to load.
  app.use(['/api/access/session', '/api/access/unlock', '/api/access/code', '/api/access/face', '/api/psyx/auth/unlock',
    '/api/psyx/auth/status'],
    (_req, res, next) => code.load().then(() => next(), error => unavailable(res, error)));

  app.post('/api/access/code/setup', handle(async (req, res) => {
    if (code.configured()) return fail(res, 409, 'ADULT_CODE_EXISTS', 'Un code parental existe déjà.');
    if (isEntry(req)) {
      return fail(res, 403, 'ADULT_CODE_SETUP_HOST_ONLY', 'Définis le code parental depuis l’ordinateur qui héberge AgentX.');
    }
    const problem = newCodeProblem(req.body);
    if (problem) return fail(res, 400, 'ADULT_CODE_INVALID', problem);
    if (!(await code.create(req.body.code))) return fail(res, 409, 'ADULT_CODE_EXISTS', 'Un code parental existe déjà.');
    logger.info('Parental code set from the host');
    return json(res, { configured: true });
  }));

  app.post('/api/access/code/change', auth.requireSession, handle(async (req, res) => {
    if (code.managedByConfig) {
      return fail(res, 409, 'ADULT_CODE_MANAGED_BY_CONFIG', 'Ce code est défini dans la configuration de l’instance ; il se change là.');
    }
    if (auth.blocked(req)) return fail(res, 429, 'ADULT_UNLOCK_RATE_LIMIT', 'Trop de tentatives. Réessaie dans quelques minutes.');
    const problem = newCodeProblem(req.body);
    if (problem) return fail(res, 400, 'ADULT_CODE_INVALID', problem);
    if (!code.verify(req.body.current)) {
      auth.recordFailure(req);
      return fail(res, 403, 'ADULT_UNLOCK_FAILED', 'Code actuel invalide.');
    }
    await code.replace(req.body.code);
    auth.revokeOthers(req);
    logger.info('Parental code changed; other adult sessions revoked');
    return json(res, { changed: true });
  }));

  app.get('/access/code', (req, res) => {
    if (!auth.current(req)) return res.redirect(302, '/unlock?next=' + encodeURIComponent('/access/code'));
    return res.set('Cache-Control', 'no-store').sendFile('code.html', { root: path.resolve(root) });
  });
}

module.exports = { registerParentalCodeRoutes };
