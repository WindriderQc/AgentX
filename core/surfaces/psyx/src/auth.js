'use strict';
const { timingSafeEqual } = require('node:crypto');

// A native integration token is separate from human LAN access. No token is
// exchanged for a browser cookie. Explicit invalid credentials always fail.
function createAuth({ accessMode = 'trusted-network', accessToken = '' } = {}) {
  function requireAccess(req, res, next) {
    const authorization = req.get('authorization');
    if (authorization || accessMode === 'token') {
      const supplied = Buffer.from(authorization?.startsWith('Bearer ') ? authorization.slice(7).trim() : '');
      const expected = Buffer.from(accessToken);
      if (!expected.length || supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) {
        return res.status(401).json({ ok: false, status: 'error', code: 'PSYX_TOKEN_REQUIRED',
          message: 'A valid native PsyX bearer token is required.' });
      }
    }
    // The singleton owner namespace is unchanged, not an authenticated human ID.
    res.locals.psyxUserId = 'default';
    return next();
  }
  return { requireAccess };
}
module.exports = { createAuth };
