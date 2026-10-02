'use strict';

jest.mock('../../config/logger', () => ({
    info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn()
}));

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const { createCodeRunner, resolveMode, mapResult } = require('../../src/services/scoring/codeRunnerClient');
const { validateJob, relativePathError, executeJob } = require('../../runner/execute');
const { buildExecutionJob } = require('../../src/services/scoring/executionHarness');
const { scoreExecution } = require('../../src/services/scoring/executionScore');

const job = () => ({
    command: 'python3',
    args: ['driver.py'],
    timeout_ms: 1000,
    memory_mb: 64,
    files: { 'driver.py': 'print("RESULT {\\"id\\": \\"a\\", \\"passed\\": true}")', 'solution.py': 'x = 1' }
});

const completed = (extra = {}) => ({
    status: 'completed', error: null, exit_code: 0, signal: null, timed_out: false,
    stdout: 'RESULT {"id": "a", "passed": true}\n', stderr: '', stdout_truncated: false, stderr_truncated: false,
    duration_ms: 12, ...extra
});

function tempDir(prefix) {
    return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

describe('choosing the runner mode from the environment', () => {
    test('is off without a jobs directory and volume with one', () => {
        const missing = path.join(os.tmpdir(), 'agentx-no-such-jobs-dir');
        expect(resolveMode({ BENCHMARK_CODE_RUNNER_JOBS_DIR: missing })).toMatchObject({ mode: 'off' });
        expect(resolveMode({ BENCHMARK_CODE_RUNNER_JOBS_DIR: missing }).reason).toContain('no jobs directory');

        const present = tempDir('agentx-jobs-');
        expect(resolveMode({ BENCHMARK_CODE_RUNNER_JOBS_DIR: present })).toEqual({ mode: 'volume', jobsDir: present, reason: null });
        fs.rmSync(present, { recursive: true, force: true });
    });

    test('honours explicit values and refuses local in production', () => {
        expect(resolveMode({ BENCHMARK_CODE_RUNNER: 'off' }).mode).toBe('off');
        expect(resolveMode({ BENCHMARK_CODE_RUNNER: 'volume' }).mode).toBe('volume');
        expect(resolveMode({ BENCHMARK_CODE_RUNNER: 'local' })).toMatchObject({ mode: 'local', reason: null });
        const refused = resolveMode({ BENCHMARK_CODE_RUNNER: 'local', NODE_ENV: 'production' });
        expect(refused.mode).toBe('off');
        expect(refused.reason).toContain('refused in production');
        expect(resolveMode({ BENCHMARK_CODE_RUNNER: 'docker' })).toMatchObject({ mode: 'off' });
    });
});

describe('mapping what the runner answered', () => {
    test('passes a completed record through and turns anything else into runner_unavailable', () => {
        expect(mapResult(completed())).toEqual({
            exit_code: 0, timed_out: false, stdout: 'RESULT {"id": "a", "passed": true}\n', stderr: '',
            duration_ms: 12, stdout_truncated: false, stderr_truncated: false
        });
        expect(mapResult({ status: 'rejected', error: 'command must be one of node, python3' }))
            .toEqual({ status: 'runner_unavailable', error: 'command must be one of node, python3' });
        expect(mapResult(null).status).toBe('runner_unavailable');
        expect(mapResult({ status: 'completed', exit_code: '0', stdout: 5 })).toMatchObject({ exit_code: null, stdout: '' });
    });
});

describe('runner modes', () => {
    test('off answers every job with runner_unavailable, which is never a score', () => {
        const runner = createCodeRunner({ mode: 'off' });
        expect(runner.isAvailable()).toBe(false);
        expect(runner.describe()).toMatchObject({ mode: 'off', available: false });
        return expect(runner.runJob(job())).resolves.toMatchObject({ status: 'runner_unavailable' });
    });

    test('local runs the injected executor in process', async () => {
        const execute = jest.fn(async () => completed());
        const runner = createCodeRunner({ mode: 'local', execute });
        expect(runner.isAvailable()).toBe(true);
        const run = await runner.runJob(job());
        expect(execute).toHaveBeenCalledWith(expect.objectContaining({ command: 'python3' }), {});
        expect(run).toMatchObject({ exit_code: 0, stdout: expect.stringContaining('RESULT') });

        const failing = createCodeRunner({ mode: 'local', execute: async () => { throw new Error('boom'); } });
        expect(await failing.runJob(job())).toEqual({ status: 'runner_unavailable', error: 'local runner failed: boom' });
    });

    test('volume submits atomically, reads the answer and cleans up after itself', async () => {
        const jobsDir = tempDir('agentx-jobs-');
        const runner = createCodeRunner({ mode: 'volume', jobsDir, queueGraceMs: 2000, pollMs: 20 });

        // A stand-in daemon: claim the queued job, check what was written,
        // answer on the volume.
        const daemon = (async () => {
            const queue = path.join(jobsDir, 'queue');
            let ids = [];
            for (let i = 0; i < 100 && ids.length === 0; i += 1) {
                await new Promise((resolve) => setTimeout(resolve, 10));
                try { ids = fs.readdirSync(queue); } catch (error) { ids = []; }
            }
            expect(ids).toHaveLength(1);
            const id = ids[0];
            const running = path.join(jobsDir, 'running', id);
            fs.mkdirSync(path.join(jobsDir, 'running'), { recursive: true });
            fs.renameSync(path.join(queue, id), running);
            const spec = JSON.parse(fs.readFileSync(path.join(running, 'job.json'), 'utf8'));
            expect(spec).toMatchObject({ id, command: 'python3', args: ['driver.py'], timeout_ms: 1000 });
            expect(spec.files).toBeUndefined();
            expect(fs.readFileSync(path.join(running, 'files', 'solution.py'), 'utf8')).toBe('x = 1');
            expect(fs.existsSync(path.join(jobsDir, 'tmp', id))).toBe(false);
            fs.mkdirSync(path.join(jobsDir, 'done', id), { recursive: true });
            fs.writeFileSync(path.join(jobsDir, 'done', id, 'result.json'), JSON.stringify({ id, ...completed() }));
            fs.rmSync(running, { recursive: true, force: true });
            return id;
        })();

        const run = await runner.runJob(job());
        const id = await daemon;
        expect(run).toMatchObject({ exit_code: 0, timed_out: false, duration_ms: 12 });
        expect(fs.existsSync(path.join(jobsDir, 'done', id))).toBe(false);
        fs.rmSync(jobsDir, { recursive: true, force: true });
    });

    test('volume withdraws a job nobody picks up, and reports it as the sidecar being down', async () => {
        const jobsDir = tempDir('agentx-jobs-');
        const runner = createCodeRunner({ mode: 'volume', jobsDir, queueGraceMs: 50, pollMs: 10 });
        const run = await runner.runJob({ ...job(), timeout_ms: 500 });
        expect(run.status).toBe('runner_unavailable');
        expect(run.error).toContain('did not pick up');
        expect(fs.readdirSync(path.join(jobsDir, 'queue'))).toEqual([]);
        expect(fs.readdirSync(path.join(jobsDir, 'tmp'))).toEqual([]);
        fs.rmSync(jobsDir, { recursive: true, force: true });
    });

    test('volume availability follows the heartbeat', () => {
        const jobsDir = tempDir('agentx-jobs-');
        let clock = Date.parse('2026-09-22T12:00:00Z');
        const runner = createCodeRunner({ mode: 'volume', jobsDir, now: () => clock, heartbeatFreshMs: 30000 });
        expect(runner.isAvailable()).toBe(false);
        fs.writeFileSync(path.join(jobsDir, 'runner.json'), JSON.stringify({ version: '1', heartbeat_at: '2026-09-22T12:00:00Z' }));
        expect(runner.isAvailable()).toBe(true);
        expect(runner.describe()).toMatchObject({ mode: 'volume', available: true, runner_version: '1', heartbeat_at: '2026-09-22T12:00:00Z' });
        clock += 31000;
        expect(runner.isAvailable()).toBe(false);
        fs.writeFileSync(path.join(jobsDir, 'runner.json'), 'not json');
        expect(runner.describe().heartbeat_at).toBeNull();
        fs.rmSync(jobsDir, { recursive: true, force: true });
    });
});

describe('what the executor refuses before starting anything', () => {
    test('validates commands, arguments, budgets and files', () => {
        expect(validateJob(job())).toEqual([]);
        expect(validateJob({ ...job(), command: 'bash' })).toContain('command must be one of node, python3');
        expect(validateJob({ ...job(), args: ['../driver.py'] })).toContain('args[0] must be a bare file name');
        expect(validateJob({ ...job(), args: ['-c'] })).toContain('args[0] must be a bare file name');
        expect(validateJob({ ...job(), args: ['other.py'] })).toContain('args[0] "other.py" is not one of the job files');
        expect(validateJob({ ...job(), timeout_ms: 60000 })).toContain('timeout_ms must be between 500 and 30000');
        expect(validateJob({ ...job(), memory_mb: 4096 })).toContain('memory_mb must be between 1 and 512');
        expect(validateJob({ ...job(), files: { '../escape.py': 'x', 'driver.py': 'x' } }))
            .toContain('files path "../escape.py" must not contain empty, "." or ".." segments');
        expect(validateJob({ ...job(), files: {} })).toContain('files must be a non-empty object');
        expect(validateJob('nope')).toEqual(['job must be an object']);
    });

    test('fills the default budgets on a valid job', () => {
        const spec = { ...job() };
        delete spec.timeout_ms;
        delete spec.memory_mb;
        expect(validateJob(spec)).toEqual([]);
        expect(spec).toMatchObject({ timeout_ms: 5000, memory_mb: 256 });
    });

    test('refuses every path that could leave the job directory', () => {
        expect(relativePathError('/etc/passwd')).toBe('must be relative');
        expect(relativePathError('C:/x')).toBe('must be relative');
        expect(relativePathError('a\\b')).toBe('must use forward slashes');
        expect(relativePathError('a/../b')).toContain('".."');
        expect(relativePathError('ok/fine.py')).toBeNull();
    });

    test('a rejected job is answered as rejected, with every reason', async () => {
        const result = await executeJob({ command: 'bash', args: [], files: {} });
        expect(result.status).toBe('rejected');
        expect(result.error).toContain('command must be one of');
        expect(result.error).toContain('args must be a non-empty array');
    });
});

// The real thing: the daemon script against a temp jobs volume, the client
// in volume mode, a generated driver run by the local interpreter. Opt-in
// because it spawns processes: BENCHMARK_DRIVER_SMOKE=1.
const describeLocal = process.env.BENCHMARK_DRIVER_SMOKE === '1' ? describe : describe.skip;

describeLocal('the daemon and the client over a jobs volume', () => {
    let jobsDir;
    let workDir;
    let daemon;

    beforeAll(() => {
        jobsDir = tempDir('agentx-jobs-');
        workDir = tempDir('agentx-work-');
        daemon = spawn(process.execPath, [path.join(__dirname, '..', '..', 'runner', 'daemon.js')], {
            env: { ...process.env, RUNNER_JOBS_DIR: jobsDir, RUNNER_WORK_DIR: workDir, RUNNER_POLL_MS: '50' },
            stdio: ['ignore', 'pipe', 'pipe']
        });
        daemon.stdout.on('data', () => {});
        daemon.stderr.on('data', (chunk) => process.stderr.write(chunk));
    });

    afterAll(async () => {
        if (daemon) {
            const exited = new Promise((resolve) => { daemon.once('exit', resolve); });
            daemon.kill('SIGTERM');
            await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 3000).unref())]);
            daemon.stdout.destroy();
            daemon.stderr.destroy();
            daemon.unref();
        }
        fs.rmSync(jobsDir, { recursive: true, force: true });
        fs.rmSync(workDir, { recursive: true, force: true });
    });

    test('a python job goes through the volume and comes back scored', async () => {
        const runner = createCodeRunner({ mode: 'volume', jobsDir, queueGraceMs: 10000, pollMs: 25 });
        for (let i = 0; i < 100 && !runner.isAvailable(); i += 1) {
            await new Promise((resolve) => setTimeout(resolve, 50));
        }
        expect(runner.isAvailable()).toBe(true);

        const fixture = {
            language: 'python',
            harness: 'function_calls',
            entry: 'is_prime',
            cases: [{ id: 'n=2', args: [2], expected: true }, { id: 'n=9', args: [9], expected: false }]
        };
        const spec = buildExecutionJob({ fixture, code: 'def is_prime(n):\n    return n > 1 and all(n % i for i in range(2, n))' });
        const run = await runner.runJob(spec);
        expect(run.status).toBeUndefined();
        expect(run.exit_code).toBe(0);
        const execution = scoreExecution({ fixture, extraction: { status: 'ok' }, run });
        expect(execution).toMatchObject({ status: 'passed', correctness: 10, passed: 2 });

        const wrong = await runner.runJob(buildExecutionJob({ fixture, code: 'def is_prime(n):\n    return True' }));
        expect(scoreExecution({ fixture, extraction: { status: 'ok' }, run: wrong })).toMatchObject({ status: 'failed', passed: 1 });

        const hang = await runner.runJob(buildExecutionJob({ fixture: { ...fixture, timeout_ms: 800 }, code: 'def is_prime(n):\n    while True: pass' }));
        expect(hang.timed_out).toBe(true);
        expect(fs.readdirSync(path.join(jobsDir, 'queue'))).toEqual([]);
        expect(fs.readdirSync(path.join(jobsDir, 'done'))).toEqual([]);
        expect(fs.readdirSync(workDir)).toEqual([]);
    }, 60000);
});
