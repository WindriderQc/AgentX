'use strict';

// Checks shared by the Benchmark and RAG single-address tests: what a rendered
// page and the service's browser files may still address at the root.
const fs = require('node:fs');
const path = require('node:path');
const { SHARED_CORE_ASSETS } = require('../sharedCoreAssets');

// Root paths that Core's shared layout emits (core/views/layouts and partials).
// Behind the single address they reach Core, which serves the same files; on a
// service reached directly they reach the service, which serves its own copy.
const SHARED_ROOT_PATHS = Object.freeze([
  ...SHARED_CORE_ASSETS.map(asset => `/${asset}`),
  '/favicon.ico', // app-icons partial; Core and both services route it
  '/vendor/fontawesome/6.4.0/css/all.min.css', // head-assets partial; pinned in all three services
]);

// Every root-absolute URL a page asks the browser to follow or load.
function rootPaths(html) {
  return [...String(html).matchAll(/\b(?:href|src|action)=(["'])(\/(?!\/)[^"']*)\1/g)]
    .map(match => match[2].replace(/[?#].*$/, ''));
}

function unprefixedPaths(html, prefix) {
  return rootPaths(html).filter(url =>
    url !== prefix && !url.startsWith(`${prefix}/`) && !SHARED_ROOT_PATHS.includes(url));
}

function prefixedAssets(html, prefix) {
  return [...new Set(rootPaths(html).filter(url => /^\/(?:css|js|vendor)\//.test(url.slice(prefix.length))
    && url.startsWith(`${prefix}/`)))];
}

function listFiles(root, extensions) {
  return fs.readdirSync(root, { withFileTypes: true }).flatMap(entry => {
    const file = path.join(root, entry.name);
    if (entry.isDirectory()) return listFiles(file, extensions);
    return extensions.includes(path.extname(entry.name)) ? [file] : [];
  });
}

// String literals in the service's browser files that address one of the
// service's own routes at the root. `ownedSegments` are the first path segments
// the service routes; `allowed` lists exact `file:literal` exceptions.
function unprefixedLiterals({ roots, prefix, ownedSegments, allowed = [] }) {
  // A bare "/" only counts where it is a link or a request target.
  const linkContext = /(?:href\s*[:=]\s*|fetch\(|EventSource\(|import\(|location(?:\.href)?\s*=\s*|\?\s*|:\s*)$/;
  const found = [];
  for (const root of roots) {
    for (const file of listFiles(root, ['.js', '.ejs'])) {
      const source = fs.readFileSync(file, 'utf8');
      for (const match of source.matchAll(/(["'`])(\/[^"'`\s]*)/g)) {
        const value = match[2];
        const segment = value.slice(1).split(/[/?#]/)[0];
        if (segment === prefix.slice(1)) continue;
        if (segment === '' ? !linkContext.test(source.slice(0, match.index)) : !ownedSegments.includes(segment)) continue;
        const id = `${path.relative(root, file).split(path.sep).join('/')}:${value}`;
        if (!allowed.includes(id)) found.push(id);
      }
    }
  }
  return found;
}

module.exports = { SHARED_ROOT_PATHS, prefixedAssets, rootPaths, unprefixedLiterals, unprefixedPaths };
