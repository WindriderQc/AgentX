'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');
const corpus = require('../../src/services/codingReplayCorpus');
const { run } = require('../../scripts/completed-coding-replay');

describe('completed coding task replay', () => {
  let root, repo, file, base, task;
  const git = (...args) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' }).trim();
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'coding-replay-test-')); repo = path.join(root, 'repo');
    fs.mkdirSync(repo); git('init', '-q'); git('config', 'user.email', 'test@example.test'); git('config', 'user.name', 'test');
    fs.writeFileSync(path.join(repo, 'sum.py'), 'def add(a,b):\n    return a-b\n');
    fs.writeFileSync(path.join(repo, 'verify.py'), 'from sum import add\nassert add(2,3)==5\n');
    git('add', '.'); git('commit', '-qm', 'original base'); base = git('rev-parse', 'HEAD');
    fs.writeFileSync(path.join(repo, 'sum.py'), 'def add(a,b):\n    return a+b\n');
    git('commit', '-qam', 'completed task');
    task = { pipelineId: '0700', status: 'done', spec: 'Repair addition.', baseRevision: base,
      originalReceiptFingerprint: 'a'.repeat(64), sourceFiles: ['sum.py'], scope: ['sum.py'],
      verification: { sourceFiles: ['verify.py'], profile: 'python-assertion/v1', argv: ['/usr/bin/python3', '-B', 'verify.py'], timeoutMs: 1000 } };
    file = path.join(root, 'corpus.json'); save([task]);
  });
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));
  function save(tasks) { fs.writeFileSync(file, JSON.stringify({ schema: corpus.SCHEMA, tasks })); }
  function args(out = path.join(root, 'report')) { return ['--corpus', file, '--repo', repo, '--out', out, '--model', 'test-model', '--host-url', 'http://host.example.test:11434']; }
  const patch = 'diff --git a/sum.py b/sum.py\n--- a/sum.py\n+++ b/sum.py\n@@ -1,2 +1,2 @@\n def add(a,b):\n-    return a-b\n+    return a+b\n';
  const verify = (cwd, profile) => ({ pass: spawnSync(profile.argv[0], profile.argv.slice(1), { cwd }).status === 0 });
  const body = content => ({ model: 'test-model', done: true, message: { content }, prompt_eval_count: 120, eval_count: 30 });

  test('reads original authority rather than the completed checkout and refuses unpinned bases', () => {
    const [snapshot] = corpus.loadCorpus(file, repo);
    expect(snapshot.authority[0].content).toContain('return a-b');
    expect(corpus.messagesForTask(snapshot)[1].content).toContain('return a-b');
    expect(snapshot.fingerprint).toMatch(/^[a-f0-9]{64}$/);
    save([{ ...task, baseRevision: 'HEAD' }]); expect(() => corpus.loadCorpus(file, repo)).toThrow('original base');
    save([{ ...task, status: 'review' }]); expect(() => corpus.loadCorpus(file, repo)).toThrow('done snapshot');
    save([{ ...task, sourceFiles: ['../secret'] }]); expect(() => corpus.loadCorpus(file, repo)).toThrow('repository-relative');
  });

  test('executes the same verifier on a detached original base and preserves the completed source', async () => {
    const infer = jest.fn(async () => body(patch)), close = jest.fn();
    const report = await run(args(), { open: async () => ({ infer, close }), verify });
    expect(report).toMatchObject({ tasks: 1, attempts: 1, verified: 1, verifiedPassRate: 1, gate: 'pass' });
    expect(report.rows[0].usage).toEqual({ effectiveModel: 'test-model', modelCalls: 1, inputTokens: 120, outputTokens: 30, totalTokens: 150 });
    expect(git('rev-parse', 'HEAD')).not.toBe(base);
    expect(git('status', '--porcelain')).toBe('');
    expect(git('worktree', 'list', '--porcelain').match(/worktree /g)).toHaveLength(1);
    expect(close).toHaveBeenCalledTimes(1);
    expect(fs.statSync(path.join(root, 'report/summary.json')).mode & 0o777).toBe(0o600);
  });

  test('counts a failed verification with its actual tokens and model', async () => {
    const badPatch = patch.replace('return a+b', 'return a*b');
    const report = await run(args(), { open: async () => ({ infer: async () => body(badPatch), close: async () => {} }), verify });
    expect(report.gate).toBe('fail'); expect(report.verifiedPassRate).toBe(0);
    expect(report.rows[0].usage).toMatchObject({ effectiveModel: 'test-model', totalTokens: 150, modelCalls: 1 });
  });

  test('checks newly created files against the scope before running verification', async () => {
    const extra = patch + 'diff --git a/escape.py b/escape.py\nnew file mode 100644\n--- /dev/null\n+++ b/escape.py\n@@ -0,0 +1 @@\n+print(1)\n';
    const verifier = jest.fn(verify);
    const report = await run(args(), { open: async () => ({ infer: async () => body(extra), close: async () => {} }), verify: verifier });
    expect(report.rows[0].verification.code).toBe('SCOPE_VIOLATION');
    expect(verifier).not.toHaveBeenCalled();
  });

  test('refuses edits to the original independent verifier even when its directory is in scope', async () => {
    save([{ ...task, scope: ['sum.py', 'verify.py'] }]);
    const weakened = patch + 'diff --git a/verify.py b/verify.py\n--- a/verify.py\n+++ b/verify.py\n@@ -1,2 +1,2 @@\n from sum import add\n-assert add(2,3)==5\n+assert True\n';
    const verifier = jest.fn(verify);
    const report = await run(args(), { open: async () => ({ infer: async () => body(weakened), close: async () => {} }), verify: verifier });
    expect(report.rows[0].verification.code).toBe('SCOPE_VIOLATION');
    expect(verifier).not.toHaveBeenCalled();
  });

  test('waits only for a proven pre-dispatch refusal and never resends an uncertain call', async () => {
    save([task, { ...task, pipelineId: '0701' }]);
    const infer = jest.fn().mockRejectedValueOnce(Object.assign(new Error('busy'), { replay: 'busy' }))
      .mockRejectedValueOnce(Object.assign(new Error('lost response'), { replay: 'stop', code: 'UNKNOWN' }));
    const wait = jest.fn();
    const report = await run(args(), { open: async () => ({ infer, close: async () => {} }), wait, verify });
    expect(infer).toHaveBeenCalledTimes(2); expect(wait).toHaveBeenCalledTimes(1);
    expect(report).toMatchObject({ busyWaits: 1, attempts: 1, gate: 'incomplete', stop: { code: 'UNKNOWN' } });
    expect(report.rows[0].usage).toEqual({ effectiveModel: null, modelCalls: null, inputTokens: null, outputTokens: null, totalTokens: null });
  });

  test('dry run performs no inference and refuses report paths inside a checkout including symlinks', async () => {
    const open = jest.fn(); const report = await run([...args(), '--dry-run'], { open });
    expect(report.gate).toBe('not_run'); expect(open).not.toHaveBeenCalled();
    await expect(run(args())).rejects.toThrow('already holds a report');
    fs.symlinkSync(repo, path.join(root, 'alias'));
    await expect(run(args(path.join(root, 'alias/report')))).rejects.toThrow('outside the checkout');
  });
});
