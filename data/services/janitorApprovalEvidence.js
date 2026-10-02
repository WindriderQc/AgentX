/**
 * janitorApprovalEvidence.js — complete duplicate proof for profile previews.
 *
 * This service is read-only. It validates the exact proposal shape, resolves
 * every duplicate member through the janitor safety gate, streams a complete
 * SHA-256 for the designated survivor and every removal target, and returns
 * immutable snapshots for the later atomic apply preflight.
 */
const crypto = require('crypto');
const fsSync = require('fs');
const fs = require('fs/promises');
const path = require('path');
const janitorService = require('./janitorService');

const SHA256_PATTERN = /^[0-9a-f]{64}$/i;

function validateDuplicateAction(action) {
  if (action?.type !== 'verified_duplicate_review' || action?.policy !== 'delete_duplicates') {
    return { ok: false, error: 'only verified duplicate review actions can be previewed' };
  }
  if (typeof action.sha256 !== 'string' || !SHA256_PATTERN.test(action.sha256)) {
    return { ok: false, error: 'action has no valid SHA-256 duplicate proof' };
  }
  if (typeof action.keep?.path !== 'string' || !action.keep.path) {
    return { ok: false, error: 'action has no explicit duplicate survivor' };
  }
  if (
    !Array.isArray(action.files)
    || action.files.length === 0
    || action.files.some(file => typeof file !== 'string' || !file)
    || new Set(action.files).size !== action.files.length
  ) {
    return { ok: false, error: 'action has duplicate or invalid file targets' };
  }
  if (action.files.includes(action.keep.path)) {
    return { ok: false, error: 'duplicate survivor cannot also be a removal target' };
  }

  const candidates = action.candidatesToRemove;
  if (
    !Array.isArray(candidates)
    || candidates.length !== action.files.length
    || candidates.some(candidate => typeof candidate?.path !== 'string' || !candidate.path)
  ) {
    return { ok: false, error: 'action removal candidates do not match its exact target list' };
  }
  const candidatePaths = candidates.map(candidate => candidate.path);
  if (
    new Set(candidatePaths).size !== candidatePaths.length
    || [...candidatePaths].sort().join('\n') !== [...action.files].sort().join('\n')
  ) {
    return { ok: false, error: 'action removal candidates do not match its exact target list' };
  }

  return {
    ok: true,
    sha256: action.sha256.toLowerCase(),
    survivorPath: action.keep.path,
    targetPaths: [...action.files]
  };
}

function hashFile(realPath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = fsSync.createReadStream(realPath);
    stream.on('error', reject);
    stream.on('data', chunk => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

function sameSnapshot(before, after) {
  return before.realPath === after.realPath
    && before.size === after.size
    && before.mtimeMs === after.mtimeMs;
}

async function verifyMember(file, expectedSha256, role) {
  const before = await janitorService.resolveForDeletion(file);
  if (!before.ok) {
    return { ok: false, error: `${role} ${file}: ${before.reason}` };
  }
  if (!Number.isFinite(before.mtimeMs)) {
    return { ok: false, error: `${role} ${file}: exact mtime is unavailable` };
  }
  let beforeLink;
  try {
    beforeLink = await fs.lstat(path.resolve(file));
  } catch (err) {
    return { ok: false, error: `${role} ${file}: unable to inspect file identity: ${err.message}` };
  }
  if (!beforeLink.isFile()) {
    return { ok: false, error: `${role} ${file}: path must be a regular non-symlink file` };
  }

  let sha256;
  try {
    sha256 = await hashFile(before.realPath);
  } catch (err) {
    return { ok: false, error: `${role} ${file}: unable to read complete file: ${err.message}` };
  }
  if (sha256 !== expectedSha256) {
    return { ok: false, error: `${role} ${file}: complete SHA-256 does not match the proposal` };
  }

  const after = await janitorService.resolveForDeletion(file);
  let afterLink;
  try {
    afterLink = await fs.lstat(path.resolve(file));
  } catch (_) {
    afterLink = null;
  }
  const identityChanged = !afterLink
    || !afterLink.isFile()
    || beforeLink.dev !== afterLink.dev
    || beforeLink.ino !== afterLink.ino;
  if (!after.ok || !sameSnapshot(before, after) || identityChanged) {
    return { ok: false, error: `${role} ${file}: file changed during complete SHA-256 verification` };
  }

  return {
    ok: true,
    snapshot: {
      file,
      real_path: after.realPath,
      size: after.size,
      mtime_ms: after.mtimeMs,
      sha256
    }
  };
}

async function verifyDuplicateAction(action) {
  const shape = validateDuplicateAction(action);
  if (!shape.ok) return shape;

  const survivor = await verifyMember(shape.survivorPath, shape.sha256, 'survivor');
  if (!survivor.ok) return survivor;

  const targets = [];
  const realPaths = new Set([survivor.snapshot.real_path]);
  for (const file of shape.targetPaths) {
    const target = await verifyMember(file, shape.sha256, 'removal target');
    if (!target.ok) return target;
    if (realPaths.has(target.snapshot.real_path)) {
      return { ok: false, error: `duplicate member ${file}: resolves to an already listed file` };
    }
    realPaths.add(target.snapshot.real_path);
    targets.push(target.snapshot);
  }

  return {
    ok: true,
    proof: 'complete-sha256-all-members',
    sha256: shape.sha256,
    verified_at: new Date(),
    survivor: survivor.snapshot,
    targets
  };
}

function generateEvidenceDigest(evidence) {
  const targets = [...(evidence?.targets || [])]
    .map(target => ({
      file: target.file,
      real_path: target.real_path,
      size: target.size,
      mtime_ms: target.mtime_ms,
      sha256: target.sha256
    }))
    .sort((a, b) => String(a.file).localeCompare(String(b.file)));
  const survivor = evidence?.survivor || {};
  const verifiedAt = evidence?.verified_at || survivor.verified_at || null;
  return crypto.createHash('sha256').update(JSON.stringify({
    proof: evidence?.proof,
    sha256: evidence?.sha256,
    verified_at: verifiedAt,
    survivor: {
      file: survivor.file,
      real_path: survivor.real_path,
      size: survivor.size,
      mtime_ms: survivor.mtime_ms,
      sha256: survivor.sha256,
      verified_at: survivor.verified_at || verifiedAt
    },
    targets
  })).digest('hex');
}

module.exports = {
  validateDuplicateAction,
  verifyDuplicateAction,
  generateEvidenceDigest
};
