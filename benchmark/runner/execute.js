'use strict';

/**
 * Run one sandbox job: materialize its files, start its command under the
 * job's budgets, and collect a bounded record of what happened.
 *
 * Shared by the runner sidecar (`daemon.js`) and by the Benchmark service's
 * in-process local mode, so it uses Node built-ins only: the sidecar image
 * carries this directory and nothing else.
 *
 * What a job may ask for is narrow by construction: one of two interpreters,
 * arguments that are bare file names, files on relative paths inside the job
 * directory, and budgets inside fixed bounds. Everything else is rejected
 * before a process starts. Output is capped, the wall clock is enforced here,
 * and the process group is killed as a whole so a driver's own children never
 * outlive the job.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const ALLOWED_COMMANDS = Object.freeze(['node', 'python3']);
const OUTPUT_CAP_BYTES = 64 * 1024;
const LIMITS = Object.freeze({
    min_timeout_ms: 500,
    max_timeout_ms: 30000,
    default_timeout_ms: 5000,
    max_memory_mb: 512,
    default_memory_mb: 256,
    max_files: 32,
    max_file_bytes: 64 * 1024,
    max_args: 8,
    max_arg_length: 255,
    max_processes: 128,
    max_open_files: 64,
    max_file_size_bytes: 8 * 1024 * 1024
});

function isPlainObject(value) {
    return !!value && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Why a path may not be materialized inside the job directory, or null.
 */
function relativePathError(rawPath) {
    if (typeof rawPath !== 'string' || rawPath.trim() === '') return 'must be a non-empty string';
    if (rawPath !== rawPath.trim()) return 'must not be padded with whitespace';
    if (rawPath.length > 255) return 'must be at most 255 characters';
    if (rawPath.includes('\0')) return 'must not contain a null byte';
    if (rawPath.includes('\\')) return 'must use forward slashes';
    if (rawPath.startsWith('/') || /^[A-Za-z]:/.test(rawPath)) return 'must be relative';
    if (rawPath.split('/').some((segment) => segment === '' || segment === '.' || segment === '..')) {
        return 'must not contain empty, "." or ".." segments';
    }
    return null;
}

function boundedInteger(value, min, max, fallback) {
    if (value === undefined || value === null) return fallback;
    const numeric = Number(value);
    if (!Number.isInteger(numeric) || numeric < min || numeric > max) return undefined;
    return numeric;
}

/**
 * Every reason a job cannot run. Empty when it can. The normalized budgets
 * are written back onto the job so the executor and the record agree.
 */
function validateJob(job) {
    const errors = [];
    if (!isPlainObject(job)) return ['job must be an object'];

    if (!ALLOWED_COMMANDS.includes(job.command)) {
        errors.push(`command must be one of ${ALLOWED_COMMANDS.join(', ')}`);
    }

    if (!Array.isArray(job.args) || job.args.length === 0) {
        errors.push('args must be a non-empty array');
    } else if (job.args.length > LIMITS.max_args) {
        errors.push(`args must hold at most ${LIMITS.max_args} entries`);
    } else {
        job.args.forEach((arg, index) => {
            if (typeof arg !== 'string' || arg === '' || arg.length > LIMITS.max_arg_length) {
                errors.push(`args[${index}] must be a short non-empty string`);
            } else if (arg.startsWith('-') || arg.includes('/') || arg.includes('\\') || arg.includes('\0') || arg === '.' || arg === '..') {
                errors.push(`args[${index}] must be a bare file name`);
            }
        });
    }

    const timeout = boundedInteger(job.timeout_ms, LIMITS.min_timeout_ms, LIMITS.max_timeout_ms, LIMITS.default_timeout_ms);
    if (timeout === undefined) errors.push(`timeout_ms must be between ${LIMITS.min_timeout_ms} and ${LIMITS.max_timeout_ms}`);
    const memory = boundedInteger(job.memory_mb, 1, LIMITS.max_memory_mb, LIMITS.default_memory_mb);
    if (memory === undefined) errors.push(`memory_mb must be between 1 and ${LIMITS.max_memory_mb}`);

    if (!isPlainObject(job.files) || Object.keys(job.files).length === 0) {
        errors.push('files must be a non-empty object');
    } else if (Object.keys(job.files).length > LIMITS.max_files) {
        errors.push(`files must hold at most ${LIMITS.max_files} entries`);
    } else {
        for (const [rawPath, contents] of Object.entries(job.files)) {
            const pathError = relativePathError(rawPath);
            if (pathError) errors.push(`files path "${rawPath}" ${pathError}`);
            else if (typeof contents !== 'string') errors.push(`files["${rawPath}"] must be a string`);
            else if (Buffer.byteLength(contents, 'utf8') > LIMITS.max_file_bytes) {
                errors.push(`files["${rawPath}"] exceeds ${LIMITS.max_file_bytes} bytes`);
            }
        }
        if (Array.isArray(job.args) && errors.length === 0 && !Object.prototype.hasOwnProperty.call(job.files, job.args[0])) {
            errors.push(`args[0] "${job.args[0]}" is not one of the job files`);
        }
    }

    if (errors.length === 0) {
        job.timeout_ms = timeout;
        job.memory_mb = memory;
    }
    return errors;
}

const commandCache = new Map();

/**
 * The executable for a job command. `node` is always this process's own
 * binary; `python3` is looked up once, preferring a full interpreter over a
 * platform alias that cannot start children.
 */
function resolveCommand(command) {
    if (command === 'node') return process.execPath;
    if (commandCache.has(command)) return commandCache.get(command);
    const candidates = process.platform === 'win32' ? ['python', 'python3', 'py'] : ['python3', 'python'];
    let resolved = null;
    for (const candidate of candidates) {
        const probe = spawnSync(candidate, ['--version'], { encoding: 'utf8', timeout: 5000 });
        if (!probe.error && probe.status === 0) { resolved = candidate; break; }
    }
    commandCache.set(command, resolved);
    return resolved;
}

let prlimitChecked = null;
function prlimitAvailable() {
    if (process.platform !== 'linux') return false;
    if (prlimitChecked === null) {
        const probe = spawnSync('prlimit', ['--version'], { encoding: 'utf8', timeout: 5000 });
        prlimitChecked = !probe.error && probe.status === 0;
    }
    return prlimitChecked;
}

function materialize(files, workDir) {
    const root = path.resolve(workDir);
    for (const [relative, contents] of Object.entries(files)) {
        const target = path.resolve(root, relative);
        if (target !== root && !target.startsWith(root + path.sep)) {
            throw new Error(`refusing to write outside the job directory: ${relative}`);
        }
        fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o755 });
        fs.writeFileSync(target, contents, { encoding: 'utf8', mode: 0o644 });
    }
}

function chownTree(dir, uid, gid) {
    fs.chownSync(dir, uid, gid);
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const target = path.join(dir, entry.name);
        if (entry.isDirectory()) chownTree(target, uid, gid);
        else fs.chownSync(target, uid, gid);
    }
}

/**
 * The process to spawn for a job. Under prlimit, V8 cannot start with an
 * address-space cap near its heap size: it reserves virtual ranges far larger
 * than the memory it uses and aborts with "Failed to reserve virtual memory
 * for CodeRange". Node jobs therefore get no --as cap and bound their heap
 * with --max-old-space-size instead; the container still caps real memory.
 */
function commandLine(job, command, usePrlimit) {
    const isNode = path.basename(String(command)).replace(/\.exe$/i, '') === 'node';
    const args = isNode ? [`--max-old-space-size=${job.memory_mb}`, ...job.args] : job.args;
    if (!usePrlimit) return { file: command, argv: args };
    return {
        file: 'prlimit',
        argv: [
            ...(isNode ? [] : [`--as=${job.memory_mb * 1024 * 1024}`]),
            `--nproc=${LIMITS.max_processes}`,
            `--nofile=${LIMITS.max_open_files}`,
            `--fsize=${LIMITS.max_file_size_bytes}`,
            `--cpu=${Math.ceil(job.timeout_ms / 1000) + 1}`,
            command,
            ...args
        ]
    };
}

/**
 * Remove a job directory. The runner keeps CHOWN but no DAC override, so root
 * cannot delete entries a job user created in its own directories (Python's
 * __pycache__ first of all). On a permission error, take the tree back with
 * chown and retry, which CHOWN allows.
 */
function removeJobDir(dir, { chownTree: chown = chownTree } = {}) {
    try {
        fs.rmSync(dir, { recursive: true, force: true });
    } catch (error) {
        if (!['EACCES', 'EPERM'].includes(error.code) || typeof process.getuid !== 'function') throw error;
        chown(dir, process.getuid(), process.getgid());
        fs.rmSync(dir, { recursive: true, force: true });
    }
}

/**
 * The environment a job sees: a path to find its interpreter, a locale, and
 * a home inside its own directory. Nothing of the caller's environment.
 */
function jobEnvironment(workDir) {
    const env = {
        PATH: process.env.PATH || '/usr/local/bin:/usr/bin:/bin',
        LANG: 'C.UTF-8',
        HOME: workDir,
        // No __pycache__: the job user would own it and cleanup could not remove it.
        PYTHONDONTWRITEBYTECODE: '1'
    };
    if (process.platform === 'win32') {
        // Local development only: a Windows interpreter cannot start without
        // its profile paths. The sidecar is Linux and never reaches this.
        for (const key of ['SYSTEMROOT', 'LOCALAPPDATA', 'APPDATA', 'USERPROFILE', 'TEMP', 'TMP']) {
            if (process.env[key]) env[key] = process.env[key];
        }
    }
    return env;
}

function killTree(child) {
    try {
        if (process.platform === 'win32') {
            spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { timeout: 5000 });
        } else {
            process.kill(-child.pid, 'SIGKILL');
        }
    } catch (error) {
        try { child.kill('SIGKILL'); } catch (ignored) { /* already gone */ }
    }
}

function collector(stream, capBytes) {
    const chunks = [];
    let size = 0;
    let truncated = false;
    stream.on('data', (chunk) => {
        if (truncated) return;
        if (size + chunk.length > capBytes) {
            chunks.push(chunk.subarray(0, Math.max(0, capBytes - size)));
            size = capBytes;
            truncated = true;
            return;
        }
        chunks.push(chunk);
        size += chunk.length;
    });
    return {
        text: () => Buffer.concat(chunks).toString('utf8'),
        truncated: () => truncated
    };
}

function failure(status, error, extra = {}) {
    return {
        status,
        error,
        exit_code: null,
        signal: null,
        timed_out: false,
        stdout: '',
        stderr: '',
        stdout_truncated: false,
        stderr_truncated: false,
        duration_ms: null,
        ...extra
    };
}

/**
 * Execute one job.
 *
 * @param {object} job `{ command, args, timeout_ms, memory_mb, files }`
 * @param {object} [options]
 * @param {string} [options.workDir] where to materialize; a temp directory
 *   is created and removed when omitted
 * @param {boolean} [options.cleanWorkDir] remove a caller-supplied workDir too
 * @param {number} [options.uid] run the job as this user (root only)
 * @param {number} [options.gid]
 * @param {boolean} [options.prlimit] wrap in `prlimit` when available (Linux)
 * @returns {Promise<object>} `status: 'completed'` with the bounded record, or
 *   `status: 'rejected' | 'runner_error'` with `error`
 */
async function executeJob(job, options = {}) {
    const errors = validateJob(job);
    if (errors.length > 0) return failure('rejected', errors.join('; '));

    const ownWorkDir = !options.workDir;
    const workDir = options.workDir || fs.mkdtempSync(path.join(os.tmpdir(), 'agentx-job-'));

    try {
        fs.mkdirSync(workDir, { recursive: true, mode: 0o755 });
        materialize(job.files, workDir);

        const command = resolveCommand(job.command);
        if (!command) return failure('runner_error', `${job.command} is not installed on the runner`);

        const asRoot = typeof process.getuid === 'function' && process.getuid() === 0;
        const dropTo = asRoot && Number.isInteger(options.uid) ? { uid: options.uid, gid: Number.isInteger(options.gid) ? options.gid : options.uid } : null;
        if (dropTo) chownTree(workDir, dropTo.uid, dropTo.gid);

        const { file, argv } = commandLine(job, command, options.prlimit && prlimitAvailable());

        const startedAt = Date.now();
        const child = spawn(file, argv, {
            cwd: workDir,
            env: jobEnvironment(workDir),
            stdio: ['pipe', 'pipe', 'pipe'],
            detached: process.platform !== 'win32',
            ...(dropTo || {})
        });

        return await new Promise((resolve) => {
            let settled = false;
            let timedOut = false;
            const stdout = collector(child.stdout, OUTPUT_CAP_BYTES);
            const stderr = collector(child.stderr, OUTPUT_CAP_BYTES);
            const timer = setTimeout(() => { timedOut = true; killTree(child); }, job.timeout_ms);

            const finish = (record) => {
                if (settled) return;
                settled = true;
                clearTimeout(timer);
                resolve(record);
            };

            child.on('error', (error) => {
                finish(failure('runner_error', `could not start ${job.command}: ${error.message}`));
            });
            child.on('close', (code, signal) => {
                finish({
                    status: 'completed',
                    error: null,
                    exit_code: Number.isInteger(code) ? code : null,
                    signal: signal || null,
                    timed_out: timedOut,
                    stdout: stdout.text(),
                    stderr: stderr.text(),
                    stdout_truncated: stdout.truncated(),
                    stderr_truncated: stderr.truncated(),
                    duration_ms: Date.now() - startedAt
                });
            });
            child.stdin.end();
        });
    } catch (error) {
        return failure('runner_error', error.message);
    } finally {
        if (ownWorkDir || options.cleanWorkDir) {
            try { removeJobDir(workDir); } catch (ignored) { /* best effort; the daemon sweep retries */ }
        }
    }
}

module.exports = {
    ALLOWED_COMMANDS,
    OUTPUT_CAP_BYTES,
    EXECUTE_LIMITS: LIMITS,
    validateJob,
    relativePathError,
    removeJobDir,
    jobEnvironment,
    commandLine,
    resolveCommand,
    prlimitAvailable,
    executeJob
};
