const { buildVaultInventory, makeDirent } = require('../../services/vaultInventoryService');
const path = require('path');
const { normalizePath } = require('../../services/obsidianVaultPolicy');
const root = path.resolve('/fixture/vault');
const policy = {
  schemaVersion: 1,
  vault: { containerRoot: root },
  inventory: { maxFiles: 10000 },
  ingestion: {
    approvedRoots: [path.join(root, 'Docs')],
    allowedExtensions: ['md', 'txt'],
    maxFileSizeBytes: 1048576,
    secretBasenames: ['.env']
  }
};

function stat(size = 0, directory = false) {
  return { size, isDirectory: () => directory };
}

function createReadOnlyFixture() {
  const root = normalizePath(policy.vault.containerRoot);
  const docs = path.join(root, 'Docs');
  const fileSystem = {
    stat: jest.fn().mockResolvedValue(stat(0, true)),
    realpath: jest.fn().mockImplementation(async (value) => value),
    readdir: jest.fn().mockImplementation(async (directory) => {
      if (directory === root) {
        return [makeDirent('Docs', 'directory'), makeDirent('outside-link', 'symlink')];
      }
      if (directory === docs) {
        return [
          makeDirent('guide.md', 'file'),
          makeDirent('.env', 'file'),
          makeDirent('large.md', 'file'),
          makeDirent('empty.txt', 'file')
        ];
      }
      return [];
    }),
    lstat: jest.fn().mockImplementation(async (filePath) => {
      if (filePath.endsWith('large.md')) return stat(policy.ingestion.maxFileSizeBytes + 1);
      if (filePath.endsWith('empty.txt')) return stat(0);
      return stat(128);
    }),
    readFile: jest.fn(),
    writeFile: jest.fn(),
    rename: jest.fn(),
    rm: jest.fn(),
    unlink: jest.fn()
  };
  return { fileSystem, root };
}

describe('Obsidian vault inventory', () => {
  it('returns aggregate metadata, excludes unsafe candidates, and follows no symlinks', async () => {
    const { fileSystem } = createReadOnlyFixture();
    const result = await buildVaultInventory({ fileSystem, policy });

    expect(result).toMatchObject({
      readOnly: true,
      contentRead: false,
      pathsIncluded: false,
      filesystemMutationAllowed: false,
      totals: { files: 4, symlinks: 1 },
      approvedCandidates: { files: 2, bytes: 128 }
    });
    expect(result.excludedByReason.secret_material.files).toBe(1);
    expect(result.excludedByReason.oversized.files).toBe(1);
    expect(result.excludedByReason.symlink_not_followed.files).toBe(1);
    expect(result.cleanupSignals.zeroByte.files).toBe(1);
    expect(result.cleanupSignals.oversized.files).toBe(1);
    expect(result).not.toHaveProperty('files');
    expect(result).not.toHaveProperty('byTopLevel');
    expect(JSON.stringify(result)).not.toMatch(/guide\.md|large\.md|empty\.txt/);
  });

  it('uses metadata operations only and performs no file mutation', async () => {
    const { fileSystem } = createReadOnlyFixture();
    await buildVaultInventory({ fileSystem, policy });

    expect(fileSystem.readFile).not.toHaveBeenCalled();
    expect(fileSystem.writeFile).not.toHaveBeenCalled();
    expect(fileSystem.rename).not.toHaveBeenCalled();
    expect(fileSystem.rm).not.toHaveBeenCalled();
    expect(fileSystem.unlink).not.toHaveBeenCalled();
  });

  it('fails closed when the vault root is absent', async () => {
    const { fileSystem } = createReadOnlyFixture();
    fileSystem.stat.mockRejectedValueOnce(new Error('ENOENT'));

    await expect(buildVaultInventory({ fileSystem, policy })).rejects.toMatchObject({
      code: 'VAULT_UNAVAILABLE'
    });
  });

  it('rejects a vault root that resolves through a symlink', async () => {
    const { fileSystem } = createReadOnlyFixture();
    fileSystem.realpath.mockResolvedValueOnce('/outside/vault');

    await expect(buildVaultInventory({ fileSystem, policy })).rejects.toMatchObject({
      code: 'VAULT_ROOT_REALPATH_MISMATCH'
    });
  });
});
