'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

jest.mock('../../utils/logger', () => ({
  log: jest.fn(),
  logger: { warn: jest.fn(), info: jest.fn(), error: jest.fn(), debug: jest.fn() }
}));

const { logger } = require('../../utils/logger');
const rolesModule = require('../../utils/fileMetadataRoles');
const { classifyFileMetadata } = require('../../utils/fileMetadata');

const { ENV_VAR, ROLE_KEYS, roleAliases, roles, resetPathRoleAliases } = rolesModule;
const VENDOR_KEY = { path: '/mnt/datalake/vendor-tools/app/Registration.key', extension: 'key', mtime: 1700000000 };

let tmpDir;
function writeAliasFile(content, name = 'aliases.json') {
  const file = path.join(tmpDir, name);
  fs.writeFileSync(file, typeof content === 'string' ? content : JSON.stringify(content));
  process.env[ENV_VAR] = file;
  resetPathRoleAliases();
  return file;
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentx-role-aliases-'));
  logger.warn.mockClear();
});

afterEach(() => {
  delete process.env[ENV_VAR];
  resetPathRoleAliases();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('path role sets', () => {
  test('every role lists built-in directory names as one array of strings', () => {
    expect(ROLE_KEYS.length).toBeGreaterThan(10);
    for (const key of ROLE_KEYS) {
      expect(Array.isArray(roleAliases[key])).toBe(true);
      expect(roleAliases[key].length).toBeGreaterThan(0);
      expect(roleAliases[key].every(entry => typeof entry === 'string' && entry.length > 0)).toBe(true);
      expect(roles()[key]).toBeInstanceOf(RegExp);
    }
  });

  test('backup directories match by whole segment on either separator, never by substring', () => {
    const { BACKUP_DIR } = roles();
    for (const value of ['/mnt/datalake/backups/a', '/mnt/datalake/cloud-backup/a', 'D:\\share\\My Backups\\a', '/x/Backup']) {
      expect(BACKUP_DIR.test(value)).toBe(true);
    }
    for (const value of ['/mnt/datalake/nobackup/a', '/mnt/datalake/backup of marlin_v1.cf3', '/mnt/datalake/backupper/a']) {
      expect(BACKUP_DIR.test(value)).toBe(false);
    }
  });

  test('never reads a file when the variable is unset', () => {
    const spy = jest.spyOn(fs, 'readFileSync');
    try {
      delete process.env[ENV_VAR];
      resetPathRoleAliases();
      roles();
      expect(spy).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
    expect(logger.warn).not.toHaveBeenCalled();
  });
});

describe('alias file', () => {
  test('extends a role so an unclassified path takes the role category', () => {
    expect(classifyFileMetadata(VENDOR_KEY)).toMatchObject({ category: 'unclassified', storage_role: 'general' });

    writeAliasFile({ version: 1, roles: { SOFTWARE_DIR: ['vendor-tools'] } });
    expect(classifyFileMetadata(VENDOR_KEY)).toMatchObject({
      category: 'resource',
      category_source: 'path-role',
      storage_role: 'application_resource'
    });
    expect(logger.warn).not.toHaveBeenCalled();
  });

  test('matches literal entries verbatim and re: entries as regex fragments', () => {
    writeAliasFile({ version: 1, roles: { SOFTWARE_DIR: ['vendor-[a-z]+'] } });
    expect(classifyFileMetadata(VENDOR_KEY)).toMatchObject({ category: 'unclassified' });
    expect(classifyFileMetadata({ ...VENDOR_KEY, path: '/mnt/datalake/vendor-[a-z]+/Registration.key' }))
      .toMatchObject({ category: 'resource', storage_role: 'application_resource' });

    writeAliasFile({ version: 1, roles: { SOFTWARE_DIR: ['re:vendor-[a-z]+'] } });
    expect(classifyFileMetadata(VENDOR_KEY)).toMatchObject({ category: 'resource', storage_role: 'application_resource' });
    expect(classifyFileMetadata({ ...VENDOR_KEY, path: '/mnt/datalake/vendor-42/Registration.key' }))
      .toMatchObject({ category: 'unclassified' });
  });

  test('accepts multi-segment literals and composes them into derived shapes', () => {
    writeAliasFile({ version: 1, roles: { EDA_DIR: ['legacy/eda-work'], BACKUP_DIR: ['mirror'] } });
    expect(classifyFileMetadata({ path: '/mnt/datalake/legacy/eda-work/board.drc', extension: 'drc', mtime: 1700000000 }))
      .toMatchObject({ category: 'engineering', storage_role: 'engineering_project' });
    expect(classifyFileMetadata({ path: '/mnt/datalake/mirror/info', mtime: 1700000000 }))
      .toMatchObject({ category: 'config', storage_role: 'backup_copy' });
    expect(classifyFileMetadata({ path: '/mnt/datalake/legacy/eda-work/README', mtime: 1700000000 }))
      .toMatchObject({ category: 'document', category_source: 'filename' });
  });

  test.each([
    ['invalid JSON', '{ "version": 1, ', /invalid JSON/],
    ['wrong version', { version: 2, roles: {} }, /version must be 1/],
    ['unknown role', { version: 1, roles: { NOT_A_ROLE: ['x'] } }, /unknown role "NOT_A_ROLE"/],
    ['non-array role', { version: 1, roles: { SOFTWARE_DIR: 'vendor-tools' } }, /is not an array/],
    ['too many entries', { version: 1, roles: { SOFTWARE_DIR: Array.from({ length: 201 }, (_, i) => `v${i}`) } }, /201 entries \(max 200\)/],
    ['oversize entry', { version: 1, roles: { SOFTWARE_DIR: ['v'.repeat(65)] } }, /exceeds 64 characters/],
    ['empty entry', { version: 1, roles: { SOFTWARE_DIR: ['  '] } }, /non-string or empty entry/],
    ['broken regex', { version: 1, roles: { SOFTWARE_DIR: ['re:vendor-('] } }, /not a valid regex/]
  ])('%s warns once naming the file and the problem, then runs without aliases', (_label, content, problem) => {
    const file = writeAliasFile(content);
    expect(classifyFileMetadata(VENDOR_KEY)).toMatchObject({ category: 'unclassified' });
    classifyFileMetadata(VENDOR_KEY);
    expect(logger.warn).toHaveBeenCalledTimes(1);
    const message = logger.warn.mock.calls[0][0];
    expect(message).toContain(ENV_VAR);
    expect(message).toContain(file);
    expect(message).toMatch(problem);
  });

  test('a missing file warns with the read error and runs without aliases', () => {
    const file = path.join(tmpDir, 'absent.json');
    process.env[ENV_VAR] = file;
    resetPathRoleAliases();
    expect(classifyFileMetadata(VENDOR_KEY)).toMatchObject({ category: 'unclassified' });
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.warn.mock.calls[0][0]).toContain(file);
    expect(logger.warn.mock.calls[0][0]).toMatch(/cannot read file \(ENOENT\)/);
  });
});
