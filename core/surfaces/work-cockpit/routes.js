'use strict';

const path = require('node:path');
const {sourceReader, projectTeam} = require('./projection');
const assets = path.join(__dirname, 'assets');
const mountPath = '/owner/work';

function registerWorkCockpit({express, scope, readPipeline, readTeam, pipelineMs = 5000, registryMs = 35000}) {
  const router = express.Router();
  // The instance's existing gateway owns the LAN boundary. Core's Household
  // middleware must already have classified this browser before either read.
  router.use((req, res, next) => {
    res.set({'Cache-Control':'private, no-store', 'Referrer-Policy':'no-referrer',
      'X-Content-Type-Options':'nosniff', 'Content-Security-Policy':
        "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; frame-ancestors 'none'; form-action 'none'; base-uri 'none'"});
    if (res.locals.familyDevicePinned === false && !req.familyDevice) return next();
    return res.sendStatus(403);
  });
  router.get('/', (_req, res) => res.sendFile(path.join(assets, 'index.html'), {cacheControl:false}));
  for (const file of ['cockpit.js','cards.js','cockpit.css']) {
    router.get('/'+file, (_req, res) => res.sendFile(path.join(assets,file), {cacheControl:false}));
  }
  const pipeline = sourceReader(() => readPipeline(scope), pipelineMs);
  const registry = sourceReader(async () => projectTeam(await readTeam()), registryMs);
  router.get('/data/pipeline', async (_req, res) => res.json(await pipeline()));
  router.get('/data/registry', async (_req, res) => res.json(await registry()));
  router.get('/data', async (_req, res) => {
    const [tasks, agents] = await Promise.all([pipeline(), registry()]);
    res.json({pipeline:tasks, registry:agents, checkedAt:new Date().toISOString()});
  });
  router.use((_req,res) => res.sendStatus(404));
  return router;
}

module.exports = {mountPath, registerWorkCockpit};
