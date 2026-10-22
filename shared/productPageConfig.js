'use strict';
const path = require('node:path');
const { screenDestinations } = require('./screenDestinations');
const { allowScreenFrame } = require('./screenView');

// Composed services reuse Core's public URLs and navigation. Only their known
// HTML destinations admit a same-origin frame, never an arbitrary API route.
function productPageConfig({ app, resolvePublicUrls, service }) {
  return async (req, res, next) => {
    try {
      if (req.method === 'GET' && !req.path.startsWith('/api/') && !path.extname(req.path)) {
        const publicUrls = await resolvePublicUrls();
        app.locals.publicUrls = publicUrls;
        res.locals.publicUrls = publicUrls;
        res.locals.trustedRuntimeNavItems = await resolvePublicUrls.resolveNavigation();
        if (req.query.view === 'screen') {
          const base = publicUrls[service];
          const allowed = screenDestinations({ publicUrls }).some(row => {
            const url = new URL(row.href, publicUrls.core);
            const own = new URL(base);
            return row.mode === 'frame' && url.origin === own.origin
              && url.pathname === own.pathname.replace(/\/$/, '') + (req.path === '/' ? '/' : req.path);
          });
          if (allowed) allowScreenFrame(res);
        }
      }
      next();
    } catch (error) { next(error); }
  };
}
module.exports = { productPageConfig };
