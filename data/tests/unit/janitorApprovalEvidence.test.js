const crypto = require('crypto');
const fs = require('fs/promises');
const fsSync = require('fs');
const os = require('os');
const path = require('path');
const { PassThrough } = require('stream');

describe('janitorApprovalEvidence', () => {
  let root;
  let keep;
  let target;
  let sha256;
  let evidence;
  const originalAllowedRoots = process.env.JANITOR_ALLOWED_ROOTS;

  function action(overrides = {}) {
    return {
      type: 'verified_duplicate_review',
      policy: 'delete_duplicates',
      sha256,
      keep: { path: keep },
      candidatesToRemove: [{ path: target }],
      files: [target],
      ...overrides
    };
  }

  beforeAll(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'agentx-janitor-evidence-'));
    process.env.JANITOR_ALLOWED_ROOTS = root;
    jest.resetModules();
    evidence = require('../../services/janitorApprovalEvidence');
    keep = path.join(root, 'keep.bin');
    target = path.join(root, 'remove.bin');
    const content = Buffer.from('same complete duplicate content');
    sha256 = crypto.createHash('sha256').update(content).digest('hex');
    await fs.writeFile(keep, content);
    await fs.writeFile(target, content);
  });

  afterEach(async () => {
    await fs.writeFile(keep, 'same complete duplicate content');
    await fs.writeFile(target, 'same complete duplicate content');
    jest.restoreAllMocks();
  });

  afterAll(async () => {
    if (originalAllowedRoots === undefined) delete process.env.JANITOR_ALLOWED_ROOTS;
    else process.env.JANITOR_ALLOWED_ROOTS = originalAllowedRoots;
    expect(path.resolve(root).startsWith(path.resolve(os.tmpdir()))).toBe(true);
    await fs.rm(root, { recursive: true, force: true });
  });

  test('streams complete SHA-256 for the explicit survivor and every target', async () => {
    const result = await evidence.verifyDuplicateAction(action());

    expect(result).toMatchObject({
      ok: true,
      proof: 'complete-sha256-all-members',
      sha256,
      survivor: { file: keep, sha256 },
      targets: [{ file: target, sha256 }]
    });
    expect(result.survivor.real_path).toBe(path.resolve(keep));
    expect(result.survivor.size).toBeGreaterThan(0);
    expect(Number.isFinite(result.survivor.mtime_ms)).toBe(true);
    expect(evidence.generateEvidenceDigest(result)).toMatch(/^[0-9a-f]{64}$/);
  });

  test('rejects a missing, non-file, protected, outside, unreadable, or hash-mismatched member', async () => {
    const missing = await evidence.verifyDuplicateAction(action({
      files: [path.join(root, 'missing.bin')],
      candidatesToRemove: [{ path: path.join(root, 'missing.bin') }]
    }));
    expect(missing.ok).toBe(false);
    expect(missing.error).toMatch(/not found/i);

    const directory = path.join(root, 'directory-member');
    await fs.mkdir(directory, { recursive: true });
    const nonFile = await evidence.verifyDuplicateAction(action({
      files: [directory], candidatesToRemove: [{ path: directory }]
    }));
    expect(nonFile.error).toMatch(/must be a file/i);

    const protectedFile = path.join(root, 'keys', 'secret.bin');
    await fs.mkdir(path.dirname(protectedFile), { recursive: true });
    await fs.copyFile(keep, protectedFile);
    const protectedResult = await evidence.verifyDuplicateAction(action({
      files: [protectedFile], candidatesToRemove: [{ path: protectedFile }]
    }));
    expect(protectedResult.error).toMatch(/protected/i);

    const outsidePath = path.join(path.dirname(root), 'outside-janitor-member.bin');
    const outside = await evidence.verifyDuplicateAction(action({
      files: [outsidePath], candidatesToRemove: [{ path: outsidePath }]
    }));
    expect(outside.error).toMatch(/safety policy/i);

    jest.spyOn(fsSync, 'createReadStream').mockImplementationOnce(() => {
      const stream = new PassThrough();
      process.nextTick(() => stream.emit('error', new Error('read denied')));
      return stream;
    });
    const unreadable = await evidence.verifyDuplicateAction(action());
    expect(unreadable.error).toMatch(/unable to read complete file.*read denied/i);

    await fs.writeFile(target, 'different content');
    const mismatch = await evidence.verifyDuplicateAction(action());
    expect(mismatch.error).toMatch(/does not match the proposal/i);
  });

  test('rejects missing survivor identity, duplicate targets, and survivor/target overlap', () => {
    expect(evidence.validateDuplicateAction(action({ keep: null })).error)
      .toMatch(/explicit duplicate survivor/i);
    expect(evidence.validateDuplicateAction(action({
      files: [target, target],
      candidatesToRemove: [{ path: target }, { path: target }]
    })).error).toMatch(/duplicate or invalid file targets/i);
    expect(evidence.validateDuplicateAction(action({
      keep: { path: target }
    })).error).toMatch(/cannot also be a removal target/i);
  });
});
