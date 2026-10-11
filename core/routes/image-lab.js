'use strict';
// The image lab: the trial site built by the workshop sessions, served read-only under /images/labo.
// Its code lives in core/public/image-lab; its images, evidence files and frozen API answers live
// on the shared image drive (<IMAGE_ARCHIVE_DIR>/atelier-site). Lots deposited under atelier-tests
// are read at each request; host occupancy and GPU readings come live from Core.
const express = require('express');
const fs = require('node:fs');
const path = require('node:path');
const labIntent = require('../src/services/images/labIntent');

const CODE = path.join(__dirname, '..', 'public', 'image-lab');
const dataRoot = () => process.env.IMAGE_ARCHIVE_DIR ? path.join(path.resolve(process.env.IMAGE_ARCHIVE_DIR), 'atelier-site') : null;
const options = { extensions: ['html', 'json'], dotfiles: 'deny', redirect: false,
  setHeaders: (response, file) => {
    response.set('Cache-Control', 'no-store').set('X-Content-Type-Options', 'nosniff');
    if (/\.(md|csv|sh|ps1)$/.test(file)) response.set('Content-Type', 'text/plain; charset=utf-8');
  } };
const lotsRoot = () => process.env.IMAGE_ARCHIVE_DIR ? path.join(path.resolve(process.env.IMAGE_ARCHIVE_DIR), 'atelier-tests') : null;
const liveSources = () => ({ listActive: require('../src/services/runtimeCoordinationService').listActive,
  hosts: require('../src/helpers/ollamaHostConfig').getConfiguredHosts,
  gpus: require('../src/services/gpuTelemetryService').getGpuTelemetryForHosts,
  workshop: require('../src/services/images/workshopPresentation').overview });

// Which machine and recipes serve image requests today, so the lab's drawing never names a retired host.
function production({ workshop }) {
  try { const view = workshop(); return { imageWorker: view.worker, imageRecipes: view.profiles.map(({ id, steps }) => ({ id, steps })) }; }
  catch { return {}; }
}

// Fresh readings from Core's GPU collector replace the mirrored ones, host by host. A host without
// a collector, or with a stale sample, keeps its mirrored reading and that reading's own date.
async function liveFleet(fleet, { hosts, gpus }) {
  try {
    const configured = hosts(), live = await gpus(configured);
    return (fleet || []).map(machine => {
      const sample = live.get(configured.find(host => host.name === machine.name)?.id);
      if (sample?.telemetry?.status !== 'fresh' || !sample.gpus.length) return machine;
      return { ...machine, gpuObservedAt: sample.telemetry.sampledAt, gpu: sample.gpus.map(g => ({ index: String(g.index), name: g.name,
        'memory.total [MiB]': String(g.vramTotal), 'memory.used [MiB]': String(g.vramUsed),
        'utilization.gpu [%]': String(g.utilization), 'temperature.gpu': String(g.temperature) })) };
    });
  } catch { return fleet; }
}

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

// A workshop session deposits a lot on the shared drive as a folder holding its images and a
// lot.json record. Each trial of each lot becomes one comparison of the lab, without any edit here.
function lotGroups(dir) {
  const groups = [];
  if (!dir || !fs.existsSync(dir)) return groups;
  for (const folder of fs.readdirSync(dir).sort()) {
    let record;
    try { record = JSON.parse(fs.readFileSync(path.join(dir, folder, 'lot.json'), 'utf8')); } catch { continue; }
    if (record.schema !== 'agentx-image-lot-record-v1' || !/^[a-zA-Z0-9._-]+$/.test(folder)) continue;
    const address = file => `/images/labo/lots/${folder}/${file}`;
    const words = (record.humanReceptions || []).flatMap(r => r.userWords || []);
    const trials = new Map();
    for (const image of record.images || []) {
      if (!image.file || !image.dimensions) continue;
      const key = `${image.trial}-${image.case}`, [width, height] = image.dimensions, m = image.measurements || {};
      if (!trials.has(key)) trials.set(key, { image, items: [] });
      trials.get(key).items.push({ id: `${folder}-${image.arm}-${image.pass}`, title: image.recipe, src: address(image.file), original: address(image.file),
        width, height, previewWidth: Math.min(width, 960), previewHeight: Math.round(height * Math.min(width, 960) / width), sha256: image.sha256,
        kind: 'master', seed: image.seed, seconds: image.generationSeconds, timeScope: 'Génération observée', status: 'Proposition',
        note: m.outsidePercentPixelsOver8 !== undefined ? `${String(m.outsidePercentPixelsOver8).replace('.', ',')} % des pixels modifiés hors de la zone demandée.` : image.components?.diffusion });
    }
    for (const [key, { image, items }] of trials) {
      const reference = image.references?.[0];
      groups.push({ id: `lot-${folder}-${key}`.toLowerCase(), title: `${record.trialTitles?.[image.trial] || image.trial} · ${image.case}`, category: record.category || 'edition',
        description: `${record.title} Dossier ${folder}.`, items, defaultPair: [0, Math.min(1, items.length - 1)], brief: image.brief,
        scope: [record.scope, words.length ? `Avis reçus : « ${words.join(' » « ')} »` : null].filter(Boolean).join(' '),
        evidence: address('lot.json'),
        ...(reference && { reference: { ...items[0], id: `${folder}-reference`, title: 'Image de départ', src: address(reference), original: address(reference), sha256: undefined } }) });
    }
  }
  return groups;
}

function createRouter({ code = CODE, data = dataRoot, lots = lotsRoot, sources = liveSources } = {}) {
  const router = express.Router();
  const intentResponse = handler => (req, res) => {
    res.set('Cache-Control', 'private, no-store').set('X-Content-Type-Options', 'nosniff');
    try { handler(req, res); }
    catch (error) { res.status(error.statusCode || 503).json({ ok: false, message: error.statusCode ? error.message : 'Recettes indisponibles.' }); }
  };
  router.get('/api/recipes/:id', intentResponse((req, res) => res.json({ ok: true, catalogue: labIntent.catalogue(req.params.id, data()) })));
  router.post('/api/intents', express.json({ limit: '32kb' }), intentResponse((req, res) => {
    const intent = labIntent.prepare(req.body, data());
    res.set('Content-Disposition', 'attachment; filename="image-lab-intent.json"').json(intent);
  }));
  router.get('/api/lab', async (_req, res) => {
    res.set('Cache-Control', 'no-store');
    try {
      const snapshot = JSON.parse(fs.readFileSync(path.join(data(), 'api', 'lab.json'), 'utf8'));
      const deposited = lotGroups(lots());
      const live = sources();
      res.json({ ...snapshot, groups: [...snapshot.groups, ...deposited], revision: `${snapshot.revision}-${deposited.length}`,
        servedAt: new Date().toISOString(), core: await occupancy(live), fleet: await liveFleet(snapshot.fleet, live), ...production(live) });
    } catch { res.status(503).json({ error: 'status_unavailable' }); }
  });
  router.use('/lots', (req, res, next) => {
    const dir = lots();
    if (!dir || !['GET', 'HEAD'].includes(req.method)) return res.status(404).end();
    express.static(dir, { ...options, extensions: false, index: false })(req, res, () => res.status(404).end());
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
module.exports = { mount, createRouter, occupancy, lotGroups, liveFleet };
