'use strict';

const path = require('node:path');
const {snapshot} = require('./projection');
const assets = path.join(__dirname, 'assets');
const mountPath = '/owner/work';

function registerWorkCockpit({express, verifyOwner, scope, readDossier, readTeam}) {
  const router = express.Router();
  // The verifier belongs to the host's authenticated owner entry. Missing or
  // indeterminate results deny the entire namespace before reading either source.
  router.use(async (req, res, next) => {
    res.set({'Cache-Control':'private, no-store', 'Referrer-Policy':'no-referrer',
      'X-Content-Type-Options':'nosniff', 'Content-Security-Policy':
        "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; frame-ancestors 'none'; form-action 'none'; base-uri 'none'"});
    try {
      if (res.locals.familyDevicePinned === false && !req.familyDevice &&
          typeof verifyOwner === 'function' && await verifyOwner(req) === true) return next();
    } catch { /* A failed owner check grants no read. */ }
    return res.sendStatus(403);
  });
  router.get('/', (_req, res) => res.sendFile(path.join(assets, 'index.html'), {cacheControl:false}));
  for (const file of ['cockpit.js','cards.js','cockpit.css']) {
    router.get('/'+file, (_req, res) => res.sendFile(path.join(assets,file), {cacheControl:false}));
  }
  router.get('/data', async (_req, res) => res.json(await snapshot({scope,readDossier,readTeam})));
  router.use((_req,res) => res.sendStatus(404));
  return router;
}

module.exports = {mountPath, registerWorkCockpit};
