/**
 * janitorService.js — path validation, cleanup policies, and constants
 *
 * Foundation module for the disk janitor toolkit. Provides:
 * - Allowlist-based path validation (replaces old blocklist approach)
 * - Cleanup policy definitions
 * - Shared constants for scan/hash limits
 */
const path = require('path');
const fs = require('fs/promises');
const fsSync = require('fs');
const crypto = require('crypto');

// ── Allowed roots ───────────────────────────────────────────────
// Only directories under these roots can be scanned or cleaned.
// Override via JANITOR_ALLOWED_ROOTS env var (comma-separated).
// Roots are resolved through path.resolve so comparisons in validatePath
// use the same separator/drive form the OS produces for candidate paths.
const ALLOWED_ROOTS = (process.env.JANITOR_ALLOWED_ROOTS
  ? process.env.JANITOR_ALLOWED_ROOTS.split(',').map(r => r.trim()).filter(Boolean)
  : ['/mnt/datalake/'])
  .map(r => path.resolve(r) + path.sep);
Object.freeze(ALLOWED_ROOTS);

// ── Cleanup policies ────────────────────────────────────────────
const POLICIES = Object.freeze({
  delete_duplicates: Object.freeze({
    id: 'delete_duplicates',
    name: 'Delete Duplicate Files',
    description: 'Review current SHA-256 duplicates using the explicitly selected survivor policy',
    enabled: true
  }),
  remove_temp_files: Object.freeze({
    id: 'remove_temp_files',
    name: 'Remove Temp Files',
    description: 'Delete temp files older than 7 days',
    enabled: true,
    age_days: 7
  }),
  remove_large_files: Object.freeze({
    id: 'remove_large_files',
    name: 'Flag Large Files',
    description: 'Files > 1GB for manual review',
    enabled: false,
    size_threshold_gb: 1
  })
});

// ── Limits ──────────────────────────────────────────────────────
const MAX_SCAN_FILES = 2000;
const MAX_HASH_SIZE = 100 * 1024 * 1024; // 100 MB

// ── Protected paths ─────────────────────────────────────────────
// Paths that must never appear in any deletion list, regardless of allowlist.
const PROTECTED_PATTERNS = ['/keys/', '/keys'];

function isProtectedPath(filePath) {
  if (!filePath || typeof filePath !== 'string') return true;
  const normalized = filePath.replace(/\\/g, '/').toLowerCase();
  return PROTECTED_PATTERNS.some(p => normalized.includes(p));
}

// ── Path validation ─────────────────────────────────────────────
/**
 * Validate a path against the allowlist.
 * Resolves traversal (../), then checks it falls under an allowed root.
 * NOTE: validates lexically only — symlinks are not dereferenced.
 * Callers that open or delete files should verify realpath at operation time.
 *
 * @param {*} p - Path to validate
 * @returns {boolean} true if the resolved path is under an allowed root
 */
function validatePath(p) {
  if (!p || typeof p !== 'string') return false;
  const resolved = path.resolve(p);
  return ALLOWED_ROOTS.some(
    root => resolved === root.slice(0, -1) || resolved.startsWith(root)
  );
}

/**
 * Resolve a path through the filesystem and verify the real target remains
 * under an allowed root. For missing paths, callers can require existence.
 *
 * @param {*} p - Path to resolve
 * @param {Object} [options]
 * @param {boolean} [options.mustExist=false] - require the path to exist
 * @param {'file'|'directory'} [options.type] - expected target type when it exists
 * @returns {Promise<{ok: boolean, path?: string, realPath?: string, reason?: string}>}
 */
async function resolveAllowedPath(p, options = {}) {
  const { mustExist = false, type } = options;
  if (!p || typeof p !== 'string') {
    return { ok: false, reason: 'Invalid path' };
  }

  const inputPath = path.resolve(p);
  let realPath = inputPath;

  try {
    realPath = await fs.realpath(inputPath);
  } catch (err) {
    if (mustExist) {
      return {
        ok: false,
        reason: err?.code === 'ENOENT' ? 'Path not found' : `Unable to resolve path: ${err.message}`
      };
    }
  }

  if (!validatePath(realPath)) {
    return { ok: false, reason: 'Blocked by safety policy' };
  }

  if (mustExist && type) {
    try {
      const stats = await fs.stat(realPath);
      if (type === 'directory' && !stats.isDirectory()) {
        return { ok: false, reason: 'Path must be a directory' };
      }
      if (type === 'file' && !stats.isFile()) {
        return { ok: false, reason: 'Path must be a file' };
      }
    } catch (err) {
      return {
        ok: false,
        reason: err?.code === 'ENOENT' ? 'Path not found' : `Unable to stat path: ${err.message}`
      };
    }
  }

  return { ok: true, path: inputPath, realPath };
}

// ── Directory analysis ─────────────────────────────────────────
/**
 * Analyze a directory: hash files, find duplicates.
 * Returns analysis object (with internal _fileMap for downstream use).
 */
async function analyzeDirectory(dirPath) {
  const fileMap = new Map();
  let totalFiles = 0, totalSize = 0, scannedFiles = 0, skippedLargeFiles = 0;
  const visitedDirs = new Set();

  async function scan(dir) {
    if (totalFiles >= MAX_SCAN_FILES) return;
    let realDir;
    try { realDir = await fs.realpath(dir); }
    catch { return; }
    if (visitedDirs.has(realDir)) return;
    visitedDirs.add(realDir);

    let entries;
    try { entries = await fs.readdir(dir, { withFileTypes: true }); }
    catch { return; }

    for (const entry of entries) {
      if (totalFiles >= MAX_SCAN_FILES) break;
      const fullPath = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) { await scan(fullPath); continue; }
      if (!entry.isFile()) continue;

      let stats;
      try { stats = await fs.stat(fullPath); }
      catch { continue; }

      totalFiles++;
      totalSize += stats.size;
      // Too large to hash → invisible to dedup. Count it so the UI can say so.
      if (stats.size > MAX_HASH_SIZE) { skippedLargeFiles++; continue; }

      try {
        const hash = await new Promise((resolve, reject) => {
          const h = crypto.createHash('sha256');
          const stream = fsSync.createReadStream(fullPath);
          stream.on('error', reject);
          stream.on('data', chunk => h.update(chunk));
          stream.on('end', () => resolve(h.digest('hex')));
        });
        if (!fileMap.has(hash)) fileMap.set(hash, []);
        // mtime is canonically epoch SECONDS across the janitor (matches
        // nas_files / scanner.js), so dedup pipelines never disagree on the unit.
        fileMap.get(hash).push({ path: fullPath, size: stats.size, mtime: Math.floor(stats.mtimeMs / 1000) });
        scannedFiles++;
      } catch { /* skip unreadable files */ }
    }
  }

  await scan(dirPath);

  const duplicates = [];
  for (const [hash, files] of fileMap.entries()) {
    if (files.length > 1) {
      duplicates.push({
        hash, count: files.length,
        files: files.map(f => f.path),
        size: files[0].size,
        wasted: files[0].size * (files.length - 1)
      });
    }
  }

  return {
    path: dirPath,
    total_files: totalFiles,
    scanned_files: scannedFiles,
    skipped_large_files: skippedLargeFiles,
    truncated: totalFiles >= MAX_SCAN_FILES, // hit the scan cap — results are partial
    total_size: totalSize,
    duplicates_count: duplicates.length,
    wasted_space: duplicates.reduce((s, d) => s + d.wasted, 0),
    duplicate_groups: duplicates.slice(0, 50),
    _fileMap: fileMap
  };
}

// ── Build suggestions from analysis ────────────────────────────
/**
 * Generate cleanup suggestions from an analysis result.
 *
 * @param {Object} analysis - Result from analyzeDirectory (must include _fileMap, duplicate_groups)
 * @param {string[]} activePolicies - Array of active policy IDs
 * @returns {Array<{policy, action, files, reason, space_saved}>}
 */
function buildSuggestions(analysis, activePolicies) {
  const suggestions = [];

  if (activePolicies.includes('delete_duplicates')) {
    for (const group of analysis.duplicate_groups) {
      const files = Array.from(analysis._fileMap.get(group.hash))
        .sort((a, b) => (a.mtime || 0) - (b.mtime || 0)); // epoch seconds — keep oldest (lowest) first
      const toDelete = files.slice(1);
      if (toDelete.length > 0) {
        suggestions.push({
          policy: 'delete_duplicates',
          action: 'delete',
          files: toDelete.map(f => f.path),
          reason: `Duplicate of ${files[0].path}`,
          space_saved: group.wasted
        });
      }
    }
  }

  if (activePolicies.includes('remove_temp_files')) {
    const ageDays = POLICIES.remove_temp_files.age_days || 7;
    const cutoffSec = Math.floor((Date.now() - ageDays * 86400000) / 1000); // mtime is epoch seconds
    for (const [, files] of analysis._fileMap) {
      for (const file of files) {
        if ((file.path.includes('/temp/') || file.path.includes('/tmp/')) && (file.mtime || 0) < cutoffSec) {
          suggestions.push({
            policy: 'remove_temp_files',
            action: 'delete',
            files: [file.path],
            reason: 'Old temp file',
            space_saved: file.size
          });
        }
      }
    }
  }

  return suggestions;
}

// ── Cleanup token generation ──────────────────────────────────
/**
 * Generate a confirmation token for a set of file paths.
 * Token = SHA256 of sorted paths joined with newline, truncated to 16 hex chars.
 *
 * NOTE: integrity check only (the approved list matches what was suggested),
 * NOT authorization — it is derivable by any client from the paths. The
 * allowlist + protected-path guard are the real trust boundary. (Peer review M2.)
 *
 * @param {string[]} filePaths
 * @returns {string} 16-char hex token
 */
function generateCleanupToken(filePaths) {
  return generateCleanupDigest(filePaths).slice(0, 16);
}

/**
 * Generate the full target-set digest used to bind a profile action preview
 * to the exact paths that were inspected. This remains an integrity value,
 * not an authorization credential.
 *
 * @param {string[]} filePaths
 * @returns {string} 64-char hex digest
 */
function generateCleanupDigest(filePaths) {
  const sorted = [...filePaths].sort();
  return crypto.createHash('sha256')
    .update(sorted.join('\n'))
    .digest('hex');
}

// ── Shared safe-delete gate ───────────────────────────────────
/**
 * The single safety gate every delete path must pass through, so the disk
 * janitor and the dedup-approve path can never drift apart on protections.
 * Applies, in order: protected-path guard (/keys/), lexical allowlist, and
 * realpath re-resolution at operation time (defeats symlink escape / TOCTOU) —
 * then a single stat to confirm it is a regular file and return its snapshot.
 * Callers unlink the original path (the scanner never indexes symlinks, so the
 * realpath guard is what blocks escape; the indexed path is what we delete).
 *
 * @param {string} filePath
 * @returns {Promise<{ok: boolean, realPath?: string, size?: number, mtimeMs?: number|null, reason?: string, skipped?: boolean}>}
 */
async function resolveForDeletion(filePath) {
  if (isProtectedPath(filePath)) {
    return { ok: false, skipped: true, reason: 'Protected path (keys/)' };
  }
  if (!validatePath(filePath)) {
    return { ok: false, reason: 'Blocked by safety policy' };
  }
  const safe = await resolveAllowedPath(filePath, { mustExist: true });
  if (!safe.ok) return { ok: false, reason: safe.reason };
  if (isProtectedPath(safe.realPath)) {
    return { ok: false, skipped: true, reason: 'Protected path (keys/)' };
  }
  try {
    const stats = await fs.stat(safe.realPath);
    if (!stats.isFile()) return { ok: false, reason: 'Path must be a file' };
    return {
      ok: true,
      realPath: safe.realPath,
      size: stats.size,
      mtimeMs: Number.isFinite(stats.mtimeMs) ? stats.mtimeMs : null
    };
  } catch (err) {
    return { ok: false, reason: err?.code === 'ENOENT' ? 'Path not found' : `Unable to stat path: ${err.message}` };
  }
}

// ── Execute cleanup ───────────────────────────────────────────
/**
 * Execute file cleanup with token validation and per-file error handling.
 * SECURITY: Never returns expected_token on mismatch (C3 fix). Routes every
 * file through resolveForDeletion (protected-path + realpath re-resolution),
 * matching the dedup-approve path — see H1 in the 2026-06-29 peer review.
 *
 * @param {string[]} filePaths - Files to delete
 * @param {string} token - Confirmation token from generateCleanupToken
 * @param {boolean} dryRun - If true, report only without deleting
 * @param {Object} [options]
 * @param {Array<{file:string, real_path?:string, size:number, mtime_ms?:number|null}>} [options.expectedTargets]
 * @param {Array<{file:string, real_path:string, size:number, mtime_ms:number}>} [options.requiredEvidenceTargets]
 *   snapshots that must still match but must never be unlinked
 * @param {boolean} [options.atomicPreflight=false] - reject the whole batch
 *   before the first unlink if any target is missing, changed, or blocked
 * @returns {Promise<Object>} Result with ok, dry_run, total_files, deleted, skipped, failed, space_freed
 */
async function executeCleanup(filePaths, token, dryRun, options = {}) {
  const expectedToken = generateCleanupToken(filePaths);
  if (token !== expectedToken) {
    return { ok: false, error: 'Invalid confirmation token' };
  }

  const results = { ok: true, dry_run: dryRun, total_files: filePaths.length, deleted: [], skipped: [], failed: [], space_freed: 0 };
  const expectedTargets = Array.isArray(options.expectedTargets)
    ? new Map(options.expectedTargets.map(target => [target.file, target]))
    : null;
  const requiredEvidenceTargets = Array.isArray(options.requiredEvidenceTargets)
    ? options.requiredEvidenceTargets
    : [];
  const eligible = [];

  const snapshotChanged = (expected, gate) => (
    !expected
    || typeof expected.real_path !== 'string'
    || expected.real_path !== gate.realPath
    || expected.size == null
    || !Number.isFinite(Number(expected.size))
    || Number(expected.size) !== gate.size
    || expected.mtime_ms == null
    || !Number.isFinite(Number(expected.mtime_ms))
    || Number(expected.mtime_ms) !== gate.mtimeMs
  );

  const evidencePaths = new Set();
  for (const evidence of requiredEvidenceTargets) {
    const evidencePath = evidence?.file;
    if (
      typeof evidencePath !== 'string'
      || !evidencePath
      || evidencePaths.has(evidencePath)
      || filePaths.includes(evidencePath)
    ) {
      results.failed.push({ file: evidencePath || null, reason: 'Invalid or duplicate restore-source evidence' });
      continue;
    }
    evidencePaths.add(evidencePath);
    const gate = await resolveForDeletion(evidencePath);
    if (!gate.ok) {
      results.failed.push({ file: evidencePath, reason: `Restore source unavailable: ${gate.reason}` });
      continue;
    }
    if (snapshotChanged(evidence, gate)) {
      results.failed.push({ file: evidencePath, reason: 'Restore source changed since recorded preview' });
    }
  }

  for (const filePath of filePaths) {
    const gate = await resolveForDeletion(filePath);
    if (!gate.ok) {
      (gate.skipped ? results.skipped : results.failed).push({ file: filePath, reason: gate.reason });
      continue;
    }

    if (expectedTargets) {
      const expected = expectedTargets.get(filePath);
      if (snapshotChanged(expected, gate)) {
        results.failed.push({ file: filePath, reason: 'File changed since recorded preview' });
        continue;
      }
    }

    eligible.push({ filePath, gate });
  }

  if (
    (options.atomicPreflight === true || requiredEvidenceTargets.length > 0)
    && (results.skipped.length || results.failed.length)
  ) {
    return {
      ...results,
      ok: false,
      preflight_failed: true,
      error: 'Cleanup preflight failed; no files were deleted'
    };
  }

  for (const { filePath, gate } of eligible) {
    try {
      if (dryRun) {
        results.deleted.push({
          file: filePath,
          action: 'would_delete',
          real_path: gate.realPath,
          size: gate.size,
          mtime_ms: gate.mtimeMs
        });
      } else {
        await fs.unlink(filePath);
        results.deleted.push({ file: filePath, action: 'deleted', size: gate.size });
      }
      results.space_freed += gate.size;
    } catch (err) {
      results.failed.push({ file: filePath, reason: err.message });
    }
  }

  return results;
}

module.exports = {
  validatePath,
  resolveAllowedPath,
  isProtectedPath,
  resolveForDeletion,
  ALLOWED_ROOTS,
  POLICIES,
  MAX_SCAN_FILES,
  MAX_HASH_SIZE,
  analyzeDirectory,
  buildSuggestions,
  generateCleanupDigest,
  generateCleanupToken,
  executeCleanup
};
