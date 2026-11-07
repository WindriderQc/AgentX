'use strict';
const path = require('node:path');

// These views mount only the read client. Native control scripts and forms are
// absent, rather than merely hidden by CSS after their handlers initialize.
function registerAssets(app) {
  app.get('/screen-read.js', (_req, res) => res.type('js').sendFile(path.join(__dirname, 'browser/consultationScreen.js')));
  app.get('/screen-read.css', (_req, res) => res.type('css').sendFile(path.join(__dirname, 'browser/consultationScreen.css')));
}
function render(res, page, prefix = '') {
  if (!['profiler', 'cluster-schedule'].includes(page)) throw new Error('Unknown consultation page');
  res.setHeader('Cache-Control', 'private, no-store');
  return res.render(path.resolve(__dirname, '../core/views/pages/consultation-screen.ejs'), {
    page, title: page === 'profiler' ? 'Profiler' : 'Cluster Schedule', prefix
  });
}
module.exports = { registerAssets, render };
