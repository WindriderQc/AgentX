'use strict';

/**
 * The Benchmark side of the code runner.
 *
 * Three modes, chosen by `BENCHMARK_CODE_RUNNER`:
 *   - `volume`  (production) hand the job to the sidecar over the shared jobs
 *               volume and wait for its answer;
 *   - `local`   (development and CI) run the same executor in this process,
 *               refused when NODE_ENV is production;
 *   - `off`     answer every job with `runner_unavailable`, so a row asks for
 *               review instead of carrying a penalty.
 * Unset, the mode is `volume` when the jobs directory exists and `off`
 * otherwise, so an instance without the sidecar degrades loudly, not wrongly.
 *
 * The client never executes anything it reads from the volume: a result is
 * parsed as JSON and mapped field by field.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const logger = require('../../../config/logger');
const { executeJob } = require('../../../runner/execute');

const MODES = Object.freeze(['volume', 'local', 'off']);
const DEFAULT_JOBS_DIR = '/jobs';
const QUEUE_GRACE_MS = 20000;
const POLL_MS = 100;
const HEARTBEAT_FRESH_MS = 30000;

/**
 * The mode the environment asks for, with the reason when it is not what the
 * environment literally said.
 */
function resolveMode(env = process.env) {
    const raw = String(env.BENCHMARK_CODE_RUNNER || '').trim().toLowerCase();
    const jobsDir = String(env.BENCHMARK_CODE_RUNNER_JOBS_DIR || DEFAULT_JOBS_DIR);

    if (raw === 'local') {
        if (env.NODE_ENV === 'production') {
            return { mode: 'off', jobsDir, reason: 'the local runner is refused in production; use the sidecar (volume) or off' };
        }
        return { mode: 'local', jobsDir, reason: null };
    }
    if (raw === 'off' || raw === 'none' || raw === 'disabled' || raw === 'false' || raw === '0') {
        return { mode: 'off', jobsDir, reason: null };
    }
    if (raw === 'volume') return { mode: 'volume', jobsDir, reason: null };
    if (raw !== '') {
        return { mode: 'off', jobsDir, reason: `unknown BENCHMARK_CODE_RUNNER value "${raw}"` };
    }
    let exists = false;
    try { exists = fs.statSync(jobsDir).isDirectory(); } catch (error) { exists = false; }
    return exists
        ? { mode: 'volume', jobsDir, reason: null }
        : { mode: 'off', jobsDir, reason: `no jobs directory at ${jobsDir}` };
}

function unavailable(error) {
    return { status: 'runner_unavailable', error };
}

/**
 * The shape `executionScore` reads, from whatever the executor or the sidecar
 * answered.
 */
function mapResult(result) {
    if (!result || typeof result !== 'object') return unavailable('runner returned no result');
    if (result.status !== 'completed') {
        return unavailable(String(result.error || result.status || 'runner error').slice(0, 500));
    }
    return {
        exit_code: Number.isInteger(result.exit_code) ? result.exit_code : null,
        timed_out: result.timed_out === true,
        stdout: typeof result.stdout === 'string' ? result.stdout : '',
        stderr: typeof result.stderr === 'string' ? result.stderr : '',
        duration_ms: Number.isFinite(result.duration_ms) ? result.duration_ms : null,
        stdout_truncated: result.stdout_truncated === true,
        stderr_truncated: result.stderr_truncated === true
    };
}

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function readHeartbeat(jobsDir) {
    try {
        const parsed = JSON.parse(fs.readFileSync(path.join(jobsDir, 'runner.json'), 'utf8'));
        return parsed && typeof parsed === 'object' ? parsed : null;
    } catch (error) {
        return null;
    }
}

/**
 * Submit over the volume: write under tmp/, rename into queue/, wait for
 * done/<id>/result.json, and withdraw the job if nobody answers in time.
 */
async function runOverVolume(job, { jobsDir, queueGraceMs, pollMs, now }) {
    const id = crypto.randomUUID();
    const tmpDir = path.join(jobsDir, 'tmp', id);
    const queueDir = path.join(jobsDir, 'queue', id);
    const doneDir = path.join(jobsDir, 'done', id);
    const resultPath = path.join(doneDir, 'result.json');

    try {
        fs.mkdirSync(path.join(tmpDir, 'files'), { recursive: true });
        const { files, ...spec } = job;
        fs.writeFileSync(path.join(tmpDir, 'job.json'), JSON.stringify({ ...spec, id, submitted_at: new Date(now()).toISOString() }), 'utf8');
        for (const [relative, contents] of Object.entries(files)) {
            const target = path.join(tmpDir, 'files', relative);
            fs.mkdirSync(path.dirname(target), { recursive: true });
            fs.writeFileSync(target, contents, 'utf8');
        }
        fs.mkdirSync(path.join(jobsDir, 'queue'), { recursive: true });
        fs.renameSync(tmpDir, queueDir);
    } catch (error) {
        fs.rmSync(tmpDir, { recursive: true, force: true });
        return unavailable(`could not submit the job: ${error.message}`);
    }

    const deadline = now() + job.timeout_ms + queueGraceMs;
    while (now() < deadline) {
        if (fs.existsSync(resultPath)) {
            let parsed;
            try {
                parsed = JSON.parse(fs.readFileSync(resultPath, 'utf8'));
            } catch (error) {
                parsed = { status: 'runner_error', error: `unreadable result: ${error.message}` };
            }
            fs.rmSync(doneDir, { recursive: true, force: true });
            return mapResult(parsed);
        }
        await sleep(pollMs);
    }

    // Nobody answered. Withdraw the job if it is still queued; if the runner
    // took it, it will clean up on its own.
    let withdrawn = false;
    try {
        fs.renameSync(queueDir, path.join(jobsDir, 'tmp', `${id}.withdrawn`));
        fs.rmSync(path.join(jobsDir, 'tmp', `${id}.withdrawn`), { recursive: true, force: true });
        withdrawn = true;
    } catch (error) {
        withdrawn = false;
    }
    return unavailable(withdrawn
        ? 'code runner did not pick up the job (sidecar down?)'
        : `code runner did not answer within ${job.timeout_ms + queueGraceMs} ms`);
}

/**
 * Build a runner. Tests pass `execute` (a fake executor) or a temp `jobsDir`.
 */
function createCodeRunner(options = {}) {
    const resolved = options.mode ? { mode: options.mode, jobsDir: options.jobsDir || DEFAULT_JOBS_DIR, reason: null } : resolveMode(options.env || process.env);
    if (!MODES.includes(resolved.mode)) throw new Error(`unknown code runner mode ${resolved.mode}`);
    const jobsDir = options.jobsDir || resolved.jobsDir;
    const execute = options.execute || executeJob;
    const queueGraceMs = Number.isFinite(options.queueGraceMs) ? options.queueGraceMs : QUEUE_GRACE_MS;
    const pollMs = Number.isFinite(options.pollMs) ? options.pollMs : POLL_MS;
    const now = options.now || Date.now;
    const heartbeatFreshMs = Number.isFinite(options.heartbeatFreshMs) ? options.heartbeatFreshMs : HEARTBEAT_FRESH_MS;

    if (resolved.reason) {
        logger.warn('Code runner is off', { reason: resolved.reason });
    }

    function heartbeat() {
        if (resolved.mode !== 'volume') return null;
        return readHeartbeat(jobsDir);
    }

    function isAvailable() {
        if (resolved.mode === 'off') return false;
        if (resolved.mode === 'local') return true;
        const beat = heartbeat();
        if (!beat || typeof beat.heartbeat_at !== 'string') return false;
        const at = Date.parse(beat.heartbeat_at);
        return Number.isFinite(at) && now() - at <= heartbeatFreshMs;
    }

    function describe() {
        const beat = heartbeat();
        return {
            mode: resolved.mode,
            jobs_dir: resolved.mode === 'volume' ? jobsDir : null,
            available: isAvailable(),
            reason: resolved.reason,
            heartbeat_at: beat && typeof beat.heartbeat_at === 'string' ? beat.heartbeat_at : null,
            runner_version: beat && beat.version ? String(beat.version) : null
        };
    }

    async function runJob(job) {
        if (!job || typeof job !== 'object') return unavailable('no job');
        if (resolved.mode === 'off') {
            return unavailable(resolved.reason ? `code runner is off: ${resolved.reason}` : 'code runner is off (BENCHMARK_CODE_RUNNER)');
        }
        if (resolved.mode === 'local') {
            try {
                return mapResult(await execute(job, {}));
            } catch (error) {
                return unavailable(`local runner failed: ${error.message}`);
            }
        }
        try {
            return await runOverVolume(job, { jobsDir, queueGraceMs, pollMs, now });
        } catch (error) {
            return unavailable(`code runner failed: ${error.message}`);
        }
    }

    return { mode: resolved.mode, isAvailable, describe, runJob };
}

let shared = null;

/**
 * The instance's runner, built from the environment once. Tests replace it.
 */
function getCodeRunner() {
    if (!shared) shared = createCodeRunner();
    return shared;
}

function setCodeRunner(runner) {
    shared = runner || null;
}

module.exports = {
    MODES,
    QUEUE_GRACE_MS,
    resolveMode,
    mapResult,
    createCodeRunner,
    getCodeRunner,
    setCodeRunner
};
