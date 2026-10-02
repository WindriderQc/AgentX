'use strict';
const { createAuth: createAccessSessions, isLoopback, timingSafeMatch } = require('../../../src/services/accessSessionService');

// The standalone/native compatibility surface shares Core's session mechanism.
function createAuth(options) {
  const auth = createAccessSessions({ loopbackBypass: true, ...options, cookieName: 'psyx_session', namespace: 'PSYX', label: 'PsyX access protection' });
  return { ...auth, requireSession(req, res, next) {
    return auth.requireSession(req, res, () => { res.locals.psyxUserId = res.locals.adultUserId; next(); });
  } };
}
module.exports = { createAuth, isLoopback, timingSafeMatch };
