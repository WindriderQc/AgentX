'use strict';

/**
 * The code runner sidecar.
 *
 * It watches a jobs volume shared with the Benchmark service, runs each job
 * as an unprivileged user under the job's budgets, and answers on the same
 * volume. It has no network, no dependencies beyond this directory, and runs
 * one job at a time.
 *
 * Volume protocol (all paths under the jobs directory):
 *   tmp/<id>/         the client writes job.json and files/** here, then
 *   queue/<id>/       renames the directory into the queue (atomic);
 *   running/<id>/     the daemon claims a job by renaming it here;
 *   done/<id>/        the daemon writes result.json here, atomically, and
 *                     removes running/<id>; the client deletes done/<id>
 *                     once it has read it.
 *   runner.json       a heartbeat the client reads to report readiness.
 *
 * Nothing in a job is ever executed by this process: job.json is data, the
 * files are copied, and the only thing started is the job's interpreter on
 * its own file.
 */

const fs = require('fs');
const path = require('path');
const { executeJob, EXECUTE_LIMITS, prlimitAvailable, removeJobDir } = require('./execute');

const VERSION = '1';
const JOBS_DIR = process.env.RUNNER_JOBS_DIR || '/jobs';
const WORK_DIR = process.env.RUNNER_WORK_DIR || '/work';
const POLL_MS = Math.max(50, Number(process.env.RUNNER_POLL_MS) || 250);
const HEARTBEAT_MS = 5000;
const RUN_AS_UID = process.env.RUNNER_UID === undefined ? 65534 : Number(process.env.RUNNER_UID);
const RUN_AS_GID = process.env.RUNNER_GID === undefined ? RUN_AS_UID : Number(process.env.RUNNER_GID);
const STALE_DONE_MS = 10 * 60 * 1000;
const STALE_TMP_MS = 10 * 60 * 1000;
const STALE_RUNNING_MS = EXECUTE_LIMITS.max_timeout_ms + 60 * 1000;

const DIRS = {
    tmp: path.join(JOBS_DIR, 'tmp'),
    queue: path.join(JOBS_DIR, 'queue'),
    running: path.join(JOBS_DIR, 'running'),
    done: path.join(JOBS_DIR, 'done')
};

const ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

let started = Date.now();
let lastHeartbeat = 0;
let stopping = false;
let jobsRun = 0;

function log(level, message, extra) {
    const line = { time: new Date().toISOString(), level, message, ...(extra || {}) };
    process.stdout.write(JSON.stringify(line) + '\n');
}

function ensureDirs() {
    for (const dir of Object.values(DIRS)) fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    fs.mkdirSync(WORK_DIR, { recursive: true, mode: 0o755 });
}

function writeAtomic(target, contents) {
    const tmp = `${target}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, contents, { encoding: 'utf8', mode: 0o644 });
    fs.renameSync(tmp, target);
}

function heartbeat(force = false) {
    const now = Date.now();
    if (!force && now - lastHeartbeat < HEARTBEAT_MS) return;
    lastHeartbeat = now;
    writeAtomic(path.join(JOBS_DIR, 'runner.json'), JSON.stringify({
        version: VERSION,
        pid: process.pid,
        started_at: new Date(started).toISOString(),
        heartbeat_at: new Date(now).toISOString(),
        jobs_run: jobsRun,
        run_as_uid: RUN_AS_UID,
        platform: process.platform,
        node: process.version
    }));
}

/**
 * Read a queued job's files tree into memory. Depth and count are bounded;
 * anything beyond the bounds makes the job unreadable rather than partial.
 */
function readFilesTree(root) {
    const files = {};
    const walk = (dir, prefix, depth) => {
        if (depth > 8) throw new Error('files tree nests too deep');
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
            if (entry.isDirectory()) {
                walk(path.join(dir, entry.name), relative, depth + 1);
            } else if (entry.isFile()) {
                if (Object.keys(files).length >= EXECUTE_LIMITS.max_files) throw new Error('too many files');
                const stat = fs.statSync(path.join(dir, entry.name));
                if (stat.size > EXECUTE_LIMITS.max_file_bytes) throw new Error(`file too large: ${relative}`);
                files[relative] = fs.readFileSync(path.join(dir, entry.name), 'utf8');
            }
        }
    };
    if (fs.existsSync(root)) walk(root, '', 0);
    return files;
}

function writeResult(id, result) {
    const doneDir = path.join(DIRS.done, id);
    fs.mkdirSync(doneDir, { recursive: true, mode: 0o755 });
    writeAtomic(path.join(doneDir, 'result.json'), JSON.stringify({
        id,
        runner: { version: VERSION, pid: process.pid, run_as_uid: RUN_AS_UID },
        finished_at: new Date().toISOString(),
        ...result
    }));
}

async function runOne(id) {
    const runningDir = path.join(DIRS.running, id);
    try {
        fs.renameSync(path.join(DIRS.queue, id), runningDir);
    } catch (error) {
        return; // already claimed, or withdrawn by the client
    }

    let job = null;
    let result;
    try {
        job = JSON.parse(fs.readFileSync(path.join(runningDir, 'job.json'), 'utf8'));
        if (!job || typeof job !== 'object' || Array.isArray(job)) throw new Error('job.json is not an object');
        job.files = readFilesTree(path.join(runningDir, 'files'));
    } catch (error) {
        result = { status: 'rejected', error: `unreadable job: ${error.message}` };
    }

    if (job && !result) {
        const startedAt = Date.now();
        log('info', 'job started', { id, command: job.command, timeout_ms: job.timeout_ms });
        result = await executeJob(job, {
            workDir: path.join(WORK_DIR, id),
            cleanWorkDir: true,
            uid: RUN_AS_UID,
            gid: RUN_AS_GID,
            prlimit: true
        });
        log('info', 'job finished', {
            id, status: result.status, exit_code: result.exit_code, timed_out: result.timed_out,
            duration_ms: result.duration_ms, wall_ms: Date.now() - startedAt
        });
    }

    jobsRun += 1;
    try {
        writeResult(id, result);
    } finally {
        fs.rmSync(runningDir, { recursive: true, force: true });
    }
}

// A leftover the runner cannot delete must never crash the daemon: log it and
// let the next sweep retry.
function sweep(dir) {
    try {
        removeJobDir(dir);
    } catch (error) {
        log('warn', 'stale directory not removed', { dir, error: error.message });
    }
}

function ageMs(target) {
    try { return Date.now() - fs.statSync(target).mtimeMs; } catch (error) { return 0; }
}

/**
 * Recover from crashes and forgetful clients: a job left in running/ by a
 * previous daemon is answered as interrupted, results nobody collected and
 * half-written submissions are removed after a while.
 */
function reapStale() {
    for (const id of safeList(DIRS.running)) {
        const dir = path.join(DIRS.running, id);
        if (ageMs(dir) > STALE_RUNNING_MS) {
            log('warn', 'stale running job answered as interrupted', { id });
            try { writeResult(id, { status: 'runner_error', error: 'job interrupted by a runner restart' }); } catch (error) { /* best effort */ }
            sweep(dir);
        }
    }
    for (const id of safeList(DIRS.done)) {
        const dir = path.join(DIRS.done, id);
        if (ageMs(dir) > STALE_DONE_MS) sweep(dir);
    }
    for (const id of safeList(DIRS.tmp)) {
        const dir = path.join(DIRS.tmp, id);
        if (ageMs(dir) > STALE_TMP_MS) sweep(dir);
    }
    for (const id of safeList(WORK_DIR)) {
        const dir = path.join(WORK_DIR, id);
        if (ageMs(dir) > STALE_RUNNING_MS) sweep(dir);
    }
}

function safeList(dir) {
    try {
        return fs.readdirSync(dir).filter((name) => ID.test(name)).sort();
    } catch (error) {
        return [];
    }
}

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main() {
    ensureDirs();
    heartbeat(true);
    log('info', 'code runner started', {
        version: VERSION, jobs_dir: JOBS_DIR, work_dir: WORK_DIR, run_as_uid: RUN_AS_UID,
        root: typeof process.getuid === 'function' ? process.getuid() === 0 : false,
        // Both must be true in the container: without root the uid drop is
        // skipped, and without prlimit the per-job rlimits are not applied.
        prlimit: prlimitAvailable()
    });

    let lastReap = 0;
    while (!stopping) {
        heartbeat();
        const queued = safeList(DIRS.queue);
        for (const id of queued) {
            if (stopping) break;
            try {
                await runOne(id);
            } catch (error) {
                log('error', 'job handling failed', { id, error: error.message });
            }
            heartbeat();
        }
        if (Date.now() - lastReap > 60 * 1000) {
            reapStale();
            lastReap = Date.now();
        }
        if (queued.length === 0) await sleep(POLL_MS);
    }
    log('info', 'code runner stopped', { jobs_run: jobsRun });
}

for (const signal of ['SIGTERM', 'SIGINT']) {
    process.on(signal, () => {
        stopping = true;
    });
}

if (require.main === module) {
    main().catch((error) => {
        log('error', 'code runner crashed', { error: error.message });
        process.exit(1);
    });
}

module.exports = { main, DIRS, VERSION };
