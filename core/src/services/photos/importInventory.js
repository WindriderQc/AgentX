'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { fail, inside, hashFile } = require('./importFiles');

/** Reuse Data's existing metadata inventory; never launch a scan or maintain
 * a second index. Hash only bounded, same-size candidates on approved roots.
 * A positive match is always re-read from disk, including stale indexed hashes.
 */
function createImportInventory({ coreUrl, dataUrl, mappings = [], maxCandidates = 500, fetchImpl = globalThis.fetch,
  retryWindowMs = 30000, now = Date.now, pause = ms => new Promise(resolve => setTimeout(resolve, ms)) }) {
  if (coreUrl && dataUrl) throw fail('INVALID_CONFIG', 'Choose one inventory owner entrance');
  if (!(coreUrl || dataUrl) || !mappings.length) return async () => ({ path: null, coverage: 'import-library-only' });
  const base = new URL(dataUrl || coreUrl);
  if (!['http:', 'https:'].includes(base.protocol) || base.username || base.password) throw fail('INVALID_CONFIG', 'Invalid inventory URL');
  if (!Number.isInteger(maxCandidates) || maxCandidates < 1 || maxCandidates > 5000) throw fail('INVALID_CONFIG', 'Invalid candidate bound');
  if (!Number.isInteger(retryWindowMs) || retryWindowMs < 0 || retryWindowMs > 120000) throw fail('INVALID_CONFIG', 'Invalid inventory retry window');
  async function fetchPage(url) {
    const deadline = now() + retryWindowMs;
    for (;;) {
      let failure;
      try {
        const response = await fetchImpl(url, { headers: { 'x-service-caller': 'photo-import' }, redirect: 'error',
          signal: AbortSignal.timeout(Math.max(1, Math.min(30000, deadline - now() || 30000))) });
        if (response.ok) return response.json();
        failure = fail('INVENTORY_UNAVAILABLE', `Inventory answered HTTP ${response.status}`);
        if (![502, 503, 504].includes(response.status)) throw failure;
      } catch (error) {
        if (!(error instanceof TypeError) && !['AbortError', 'TimeoutError'].includes(error.name)) throw error;
        failure = fail('INVENTORY_UNAVAILABLE', 'Inventory is unreachable; the original import remains pending');
      }
      if (now() >= deadline) throw failure;
      // Only this read-only GET is retried. No receiver effect or phone read
      // is replayed, and unavailable inventory never proves no duplicates.
      await pause(Math.min(500, deadline - now()));
    }
  }
  return async (item) => {
    let inspected = 0;
    for (const mapping of mappings) {
      const root = await fs.realpath(mapping.physicalRoot);
      const indexedRoot = mapping.indexedRoot.replace(/\/+$/, '');
      for (let page = 1; ; page++) {
        const url = new URL(dataUrl ? '/api/v1/storage/files/browse' : '/api/data-toolbox/storage/files', base);
        url.search = new URLSearchParams({ root: indexedRoot, minSize: String(item.size), maxSize: String(item.size), page: String(page), limit: '100', sortBy: 'filename', sortOrder: 'asc' });
        const body = await fetchPage(url);
        const data = body.data;
        if (!data || !Array.isArray(data.files) || !Number.isInteger(data.pagination?.pages)) throw fail('INVENTORY_UNAVAILABLE', 'Invalid inventory response');
        for (const candidate of data.files) {
          if (candidate.storage_role === 'backup_copy') continue;
          if (++inspected > maxCandidates) throw fail('INVENTORY_LIMIT', 'Same-size candidate bound reached; no duplicate conclusion');
          if (typeof candidate.path !== 'string' || !candidate.path.startsWith(indexedRoot + '/')) continue;
          const relative = candidate.path.slice(indexedRoot.length + 1);
          if (relative.split('/').some(s => s === '..' || s === '.')) throw fail('UNSAFE_INVENTORY_PATH', 'Invalid indexed path');
          const mapped = path.resolve(root, relative);
          if (!inside(root, mapped)) throw fail('UNSAFE_INVENTORY_PATH', 'Indexed file leaves approved root');
          let real;
          try { real = await fs.realpath(mapped); } catch (error) { if (error.code === 'ENOENT') continue; throw error; }
          if (!inside(root, real) || real !== mapped) throw fail('UNSAFE_INVENTORY_PATH', 'Symlink in indexed path');
          const stat = await fs.lstat(real);
          if (!stat.isFile() || stat.size !== item.size) continue;
          const actual = await hashFile(real);
          if (actual.sha256 === item.sha256) return { path: real, coverage: 'same-size-inventory-candidates' };
        }
        if (page >= data.pagination.pages) break;
      }
    }
    return { path: null, coverage: 'same-size-inventory-candidates' };
  };
}

module.exports = { createImportInventory };
