'use strict';
// The image lab: the trial site built by the workshop sessions, served read-only under /images/labo.
// Its code lives in core/public/image-lab; its images, evidence files and frozen API answers live
// on the shared image drive (<IMAGE_ARCHIVE_DIR>/atelier-site). Only the hosts' occupancy is live.
const express = require('express');
const fs = require('node:fs');
const path = require('node:path');

const CODE = path.join(__dirname, '..', 'public', 'image-lab');
const dataRoot = () => process.env.IMAGE_ARCHIVE_DIR ? path.join(path.resolve(process.env.IMAGE_ARCHIVE_DIR), 'atelier-site') : null;
const options = { extensions: ['html', 'json'], dotfiles: 'deny', redirect: false,
  setHeaders: (response, file) => {
    response.set('Cache-Control', 'no-store').set('X-Content-Type-Options', 'nosniff');
    if (/\.(md|csv|sh|ps1)$/.test(file)) response.set('Content-Type', 'text/plain; charset=utf-8');
  } };
const liveSources = () => ({ listActive: require('../src/services/runtimeCoordinationService').listActive,
  hosts: require('../src/helpers/ollamaHostConfig').getConfiguredHosts });

async function occupancy({ listActive, hosts }) {
  const observedAt = new Date().toISOString();
  try {
    const active = await listActive(), byHost = {};
    for (const host of hosts()) {
      const row = byHost[host.name.replace(/ CPU$/, '')] ||= { workloads: 0, inferences: 0, blocked: !!active.maintenance };
      row.workloads += active.workloads.filter(w => w.hosts.includes(host.url)).length;
      row.inferences += active.inferences.filter(i => i.host === host.url).length;
      row.blocked ||= row.workloads > 0 || row.inferences > 0;
    }
    return { available: true, observedAt, maintenance: !!active.maintenance, byHost };
  } catch { return { available: false, observedAt, reason: 'Relevé Core indisponible ; admission à vérifier' }; }
}

function createRouter({ code = CODE, data = dataRoot, sources = liveSources } = {}) {
  const router = express.Router();
  router.get('/api/lab', async (_req, res) => {
    res.set('Cache-Control', 'no-store');
    try {
      const snapshot = JSON.parse(fs.readFileSync(path.join(data(), 'api', 'lab.json'), 'utf8'));
      res.json({ ...snapshot, servedAt: new Date().toISOString(), core: await occupancy(sources()) });
    } catch { res.status(503).json({ error: 'status_unavailable' }); }
  });
  router.use((req, res, next) => {
    const roots = [code, data()].filter(Boolean);
    if (!['GET', 'HEAD'].includes(req.method)) return res.status(404).end();
    // A page may share its name with a folder (/campaign and /campaign/archive): the page wins.
    const page = req.path.replace(/\/$/, '') + '.html';
    if (!path.extname(req.path) && !page.includes('..') && roots.some(dir => fs.existsSync(path.join(dir, page)))) req.url = page;
    const serve = index => index === roots.length ? res.status(404).end()
      : express.static(roots[index], options)(req, res, error => error ? res.status(404).end() : serve(index + 1));
    serve(0);
  });
  return router;
}
function mount(app) { app.use('/images/labo', createRouter()); }
module.exports = { mount, createRouter, occupancy };
