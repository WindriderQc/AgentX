const fs = require('fs/promises');
const path = require('path');

const {
  classifyVaultPath,
  isPathUnderRoot,
  loadVaultPolicy,
  normalizeExtension,
  normalizePath
} = require('./obsidianVaultPolicy');

function incrementBucket(target, key, size) {
  const bucket = target[key] || { files: 0, bytes: 0 };
  bucket.files += 1;
  bucket.bytes += size;
  target[key] = bucket;
}

function makeDirent(name, type) {
  return {
    name,
    isDirectory: () => type === 'directory',
    isFile: () => type === 'file',
    isSymbolicLink: () => type === 'symlink'
  };
}

async function buildVaultInventory(options = {}) {
  const fileSystem = options.fileSystem || fs;
  const policy = options.policy || loadVaultPolicy();
  const root = normalizePath(options.root || policy.vault.containerRoot);
  const configuredRoot = normalizePath(policy.vault.containerRoot);
  const approvedRoots = options.approvedRoots || (
    root === configuredRoot ? policy.ingestion.approvedRoots : [root]
  );
  const maxFiles = Math.max(1, Number(options.maxFiles || policy.inventory.maxFiles || 10000));

  let rootStat;
  let realRoot;
  try {
    [rootStat, realRoot] = await Promise.all([fileSystem.stat(root), fileSystem.realpath(root)]);
  } catch (error) {
    const unavailable = new Error(`Obsidian vault is unavailable at ${root}: ${error.message}`);
    unavailable.code = 'VAULT_UNAVAILABLE';
    throw unavailable;
  }
  if (!rootStat.isDirectory()) {
    const invalid = new Error(`Obsidian vault root is not a directory: ${root}`);
    invalid.code = 'VAULT_INVALID_ROOT';
    throw invalid;
  }
  if (normalizePath(realRoot) !== root) {
    const mismatch = new Error('Obsidian vault root resolves outside its configured path');
    mismatch.code = 'VAULT_ROOT_REALPATH_MISMATCH';
    throw mismatch;
  }

  const inventory = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    root,
    mountMode: 'read-only',
    readOnly: true,
    contentRead: false,
    pathsIncluded: false,
    filesystemMutationAllowed: false,
    maxFiles,
    truncated: false,
    totals: { files: 0, bytes: 0, directories: 0, symlinks: 0 },
    approvedCandidates: { files: 0, bytes: 0 },
    excludedByReason: {},
    byExtension: {},
    cleanupSignals: {
      zeroByte: { files: 0, bytes: 0 },
      oversized: { files: 0, bytes: 0 },
      generatedExport: { files: 0, bytes: 0 }
    }
  };

  const pending = [root];
  while (pending.length && !inventory.truncated) {
    const directory = pending.pop();
    const realDirectory = normalizePath(await fileSystem.realpath(directory));
    if (!isPathUnderRoot(realDirectory, realRoot) || realDirectory !== normalizePath(directory)) {
      inventory.totals.symlinks += 1;
      incrementBucket(inventory.excludedByReason, 'symlink_not_followed', 0);
      continue;
    }
    const entries = await fileSystem.readdir(directory, { withFileTypes: true });
    inventory.totals.directories += 1;

    for (const entry of entries) {
      const entryPath = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) {
        inventory.totals.symlinks += 1;
        incrementBucket(inventory.excludedByReason, 'symlink_not_followed', 0);
        continue;
      }
      if (entry.isDirectory()) {
        pending.push(entryPath);
        continue;
      }
      if (!entry.isFile()) continue;

      if (inventory.totals.files >= maxFiles) {
        inventory.truncated = true;
        break;
      }

      const stat = await fileSystem.lstat(entryPath);
      if (typeof stat.isSymbolicLink === 'function' && stat.isSymbolicLink()) {
        inventory.totals.symlinks += 1;
        incrementBucket(inventory.excludedByReason, 'symlink_not_followed', 0);
        continue;
      }
      const size = Number(stat.size || 0);
      const extension = normalizeExtension('', entryPath) || '(none)';
      const classification = classifyVaultPath(entryPath, {
        policy,
        vaultRoot: root,
        approvedRoots,
        record: { ext: extension, size }
      });

      inventory.totals.files += 1;
      inventory.totals.bytes += size;
      incrementBucket(inventory.byExtension, extension, size);

      if (size === 0) incrementBucket(inventory.cleanupSignals.zeroByte, 'total', size);
      if (classification.allowed) {
        inventory.approvedCandidates.files += 1;
        inventory.approvedCandidates.bytes += size;
      } else {
        incrementBucket(inventory.excludedByReason, classification.reason, size);
        if (classification.reason === 'oversized') {
          incrementBucket(inventory.cleanupSignals.oversized, 'total', size);
        }
        if (classification.reason === 'generated_export') {
          incrementBucket(inventory.cleanupSignals.generatedExport, 'total', size);
        }
      }
    }
  }

  for (const signal of Object.values(inventory.cleanupSignals)) {
    const total = signal.total || { files: 0, bytes: 0 };
    signal.files = total.files;
    signal.bytes = total.bytes;
    delete signal.total;
  }

  return inventory;
}

module.exports = { buildVaultInventory, incrementBucket, makeDirent };
