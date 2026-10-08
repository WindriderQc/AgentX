'use strict';

const path = require('node:path');

// Core browser assets that Benchmark and RAG serve at the same URL. Each path
// is relative to core/public and is also the route. The images copy exactly
// these files (docker/benchmark.Dockerfile, docker/rag.Dockerfile); a test
// keeps both lists equal.
const SHARED_CORE_ASSETS = Object.freeze([
  'favicon.svg',
  'img/favicon.ico',
  'img/apple-touch-icon.png',
  'dist/shared-tokens.css',
  'dist/shared-utils.js',
  'css/local-fonts.css',
  'css/platform-chrome.css',
  'css/product-shell.css',
  'css/shortcuts-modal.css',
  'js/product-navigation.js',
  'js/utils/polling-controller.js',
  'js/utils/polling-controller-global.js',
  'js/utils/shared.js',
  'js/utils/typed-confirmation.js',
  'js/utils/shortcut-hints.js',
  'js/utils/shortcuts-modal.js',
  'js/utils/toast.js'
]);

const CORE_PUBLIC_ROOT = path.join(__dirname, '..', 'core', 'public');

function mountSharedCoreAssets(app) {
  for (const asset of SHARED_CORE_ASSETS) {
    const file = path.join(CORE_PUBLIC_ROOT, ...asset.split('/'));
    app.get(`/${asset}`, (_req, res) => res.sendFile(file));
  }
}

module.exports = { SHARED_CORE_ASSETS, mountSharedCoreAssets };
