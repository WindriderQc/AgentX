'use strict';

/**
 * Reference tests: the authored fixture that lets a coding prompt be scored by
 * executing the candidate's code instead of asking a judge to read it.
 *
 * The fixture is authored beside the prompt and snapshotted onto the result
 * row, like `output_contract`, so a prompt's tests are versioned with it and
 * historical rows keep the fixture they were scored against.
 *
 * This module is pure: it validates and canonicalizes, it never reads a file,
 * spawns a process or touches the database. It is the single authority on the
 * fixture shape, shared by the catalog loader, the scorer and the runner
 * client. Anything it rejects never reaches an executor.
 *
 * Three harnesses:
 *   - `function_calls`  the driver imports `entry` and calls it per case,
 *                       comparing the return value with `expected`.
 *   - `stdin_stdout`    the candidate runs as a script, once per case, with
 *                       `stdin` on standard input and its output compared with
 *                       `expected_stdout` under `match`.
 *   - `test_file`       the fixture brings its own driver in `files`; the job
 *                       passes when it exits 0, and per-case `RESULT {json}`
 *                       lines refine that into per-case outcomes.
 */

const HARNESSES = Object.freeze(['function_calls', 'stdin_stdout', 'test_file']);
const LANGUAGES = Object.freeze(['python', 'javascript']);
const MATCH_MODES = Object.freeze(['trimmed', 'exact', 'tokens']);
const SUPPORTED_VERSIONS = Object.freeze([1]);

/**
 * Bounds an authored fixture must respect. They keep one job small enough that
 * a sandbox refusal is a defect in the fixture, not a surprise at runtime.
 */
const LIMITS = Object.freeze({
    max_files: 32,
    max_file_bytes: 64 * 1024,
    max_cases: 200,
    min_timeout_ms: 500,
    max_timeout_ms: 30000,
    default_timeout_ms: 5000,
    max_memory_mb: 512,
    default_memory_mb: 256,
    max_id_length: 64,
    max_path_length: 255,
    max_stream_bytes: 64 * 1024,
    max_value_depth: 8,
    max_weight: 1000
});

/**
 * The job directory layout. The candidate's extracted code and the generated
 * driver own these names, so an authored fixture may not claim them.
 */
const CANDIDATE_FILES = Object.freeze({ python: 'solution.py', javascript: 'solution.js' });
const DRIVER_FILES = Object.freeze({ python: 'driver.py', javascript: 'driver.js' });
const TEST_FILE_ENTRYPOINTS = Object.freeze({ python: 'test_main.py', javascript: 'test_main.js' });
const RESERVED_FILES = Object.freeze([
    'job.json',
    ...Object.values(CANDIDATE_FILES),
    ...Object.values(DRIVER_FILES)
]);

const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;
const TOP_LEVEL_KEYS = Object.freeze([
    'version', 'language', 'harness', 'entry', 'timeout_ms', 'memory_mb', 'cases', 'files'
]);
const CASE_KEYS = Object.freeze({
    function_calls: ['id', 'args', 'expected', 'weight'],
    stdin_stdout: ['id', 'stdin', 'expected_stdout', 'match', 'weight'],
    test_file: ['id', 'weight']
});

function isPlainObject(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
}

function has(object, key) {
    return Object.prototype.hasOwnProperty.call(object, key);
}

function byteLength(value) {
    return Buffer.byteLength(String(value), 'utf8');
}

/**
 * Why a value cannot travel to a runner as JSON, or null when it can. Rejects
 * what `JSON.stringify` would silently drop or turn into `null`.
 */
function jsonValueError(value, label, depth = 0) {
    if (depth > LIMITS.max_value_depth) {
        return `${label} nests deeper than ${LIMITS.max_value_depth} levels`;
    }
    if (value === null) return null;
    const type = typeof value;
    if (type === 'boolean' || type === 'string') return null;
    if (type === 'number') {
        return Number.isFinite(value) ? null : `${label} must be a finite number`;
    }
    if (Array.isArray(value)) {
        for (let index = 0; index < value.length; index += 1) {
            const error = jsonValueError(value[index], `${label}[${index}]`, depth + 1);
            if (error) return error;
        }
        return null;
    }
    if (isPlainObject(value)) {
        for (const key of Object.keys(value)) {
            const error = jsonValueError(value[key], `${label}.${key}`, depth + 1);
            if (error) return error;
        }
        return null;
    }
    return `${label} must be a JSON value`;
}

/**
 * Why a fixture file path is unsafe to materialize, or null when it is safe.
 * Only relative, forward-slashed paths inside the job directory are allowed.
 */
function filePathError(rawPath) {
    if (typeof rawPath !== 'string' || rawPath.trim() === '') {
        return 'must be a non-empty string';
    }
    if (rawPath !== rawPath.trim()) return 'must not be padded with whitespace';
    if (rawPath.length > LIMITS.max_path_length) {
        return `must be at most ${LIMITS.max_path_length} characters`;
    }
    if (rawPath.includes('\0')) return 'must not contain a null byte';
    if (rawPath.includes('\\')) return 'must use forward slashes';
    if (rawPath.startsWith('/')) return 'must be relative';
    if (/^[A-Za-z]:/.test(rawPath)) return 'must be relative';
    const segments = rawPath.split('/');
    if (segments.some((segment) => segment === '' || segment === '.' || segment === '..')) {
        return 'must not contain empty, "." or ".." segments';
    }
    return null;
}

function boundedInteger(value, { min, max, fallback, label, errors }) {
    if (value === undefined || value === null) return fallback;
    const numeric = Number(value);
    if (!Number.isFinite(numeric) || !Number.isInteger(numeric)) {
        errors.push(`${label} must be an integer`);
        return fallback;
    }
    if (numeric < min || numeric > max) {
        errors.push(`${label} must be between ${min} and ${max}`);
        return fallback;
    }
    return numeric;
}

function normalizeWeight(rawWeight, label, errors) {
    if (rawWeight === undefined || rawWeight === null) return 1;
    const numeric = Number(rawWeight);
    if (!Number.isFinite(numeric) || numeric <= 0) {
        errors.push(`${label} must be a positive number`);
        return 1;
    }
    if (numeric > LIMITS.max_weight) {
        errors.push(`${label} must be at most ${LIMITS.max_weight}`);
        return 1;
    }
    return numeric;
}

function rejectUnknownKeys(object, allowed, label, errors) {
    for (const key of Object.keys(object)) {
        if (!allowed.includes(key)) errors.push(`${label} has unknown field "${key}"`);
    }
}

function normalizeCaseId(rawCase, index, seen, errors) {
    const label = `cases[${index}].id`;
    if (!has(rawCase, 'id')) {
        errors.push(`${label} is required`);
        return null;
    }
    const id = rawCase.id;
    if (typeof id !== 'string' || id.trim() === '') {
        errors.push(`${label} must be a non-empty string`);
        return null;
    }
    const trimmed = id.trim();
    if (trimmed.length > LIMITS.max_id_length) {
        errors.push(`${label} must be at most ${LIMITS.max_id_length} characters`);
        return null;
    }
    // eslint-disable-next-line no-control-regex
    if (/[\x00-\x1f\x7f]/.test(trimmed)) {
        errors.push(`${label} must not contain control characters`);
        return null;
    }
    if (seen.has(trimmed)) {
        errors.push(`${label} duplicates an earlier case id`);
        return null;
    }
    seen.add(trimmed);
    return trimmed;
}

function normalizeFunctionCallsCase(rawCase, index, id, errors) {
    const normalized = { id, args: [], expected: null, weight: 1 };

    if (!has(rawCase, 'args')) {
        errors.push(`cases[${index}].args is required for the function_calls harness`);
    } else if (!Array.isArray(rawCase.args)) {
        errors.push(`cases[${index}].args must be an array`);
    } else {
        const error = jsonValueError(rawCase.args, `cases[${index}].args`);
        if (error) errors.push(error);
        else normalized.args = rawCase.args;
    }

    if (!has(rawCase, 'expected')) {
        errors.push(`cases[${index}].expected is required for the function_calls harness`);
    } else {
        const error = jsonValueError(rawCase.expected, `cases[${index}].expected`);
        if (error) errors.push(error);
        else normalized.expected = rawCase.expected;
    }

    normalized.weight = normalizeWeight(rawCase.weight, `cases[${index}].weight`, errors);
    return normalized;
}

function normalizeStdinStdoutCase(rawCase, index, id, errors) {
    const normalized = { id, stdin: '', expected_stdout: '', match: 'trimmed', weight: 1 };

    if (has(rawCase, 'stdin')) {
        if (typeof rawCase.stdin !== 'string') {
            errors.push(`cases[${index}].stdin must be a string`);
        } else if (byteLength(rawCase.stdin) > LIMITS.max_stream_bytes) {
            errors.push(`cases[${index}].stdin exceeds ${LIMITS.max_stream_bytes} bytes`);
        } else {
            normalized.stdin = rawCase.stdin;
        }
    }

    if (!has(rawCase, 'expected_stdout')) {
        errors.push(`cases[${index}].expected_stdout is required for the stdin_stdout harness`);
    } else if (typeof rawCase.expected_stdout !== 'string') {
        errors.push(`cases[${index}].expected_stdout must be a string`);
    } else if (byteLength(rawCase.expected_stdout) > LIMITS.max_stream_bytes) {
        errors.push(`cases[${index}].expected_stdout exceeds ${LIMITS.max_stream_bytes} bytes`);
    } else {
        normalized.expected_stdout = rawCase.expected_stdout;
    }

    if (has(rawCase, 'match')) {
        if (!MATCH_MODES.includes(rawCase.match)) {
            errors.push(`cases[${index}].match must be one of ${MATCH_MODES.join(', ')}`);
        } else {
            normalized.match = rawCase.match;
        }
    }

    normalized.weight = normalizeWeight(rawCase.weight, `cases[${index}].weight`, errors);
    return normalized;
}

function normalizeCases(rawCases, harness, errors) {
    if (rawCases === undefined || rawCases === null) {
        if (harness !== 'test_file') {
            errors.push(`cases is required for the ${harness} harness`);
        }
        return [];
    }
    if (!Array.isArray(rawCases)) {
        errors.push('cases must be an array');
        return [];
    }
    if (rawCases.length === 0 && harness !== 'test_file') {
        errors.push(`cases must list at least one case for the ${harness} harness`);
        return [];
    }
    if (rawCases.length > LIMITS.max_cases) {
        errors.push(`cases must hold at most ${LIMITS.max_cases} entries`);
        return [];
    }

    const seen = new Set();
    const normalized = [];
    for (let index = 0; index < rawCases.length; index += 1) {
        const rawCase = rawCases[index];
        if (!isPlainObject(rawCase)) {
            errors.push(`cases[${index}] must be an object`);
            continue;
        }
        rejectUnknownKeys(rawCase, CASE_KEYS[harness], `cases[${index}]`, errors);
        const id = normalizeCaseId(rawCase, index, seen, errors);
        if (id === null) continue;

        if (harness === 'function_calls') {
            normalized.push(normalizeFunctionCallsCase(rawCase, index, id, errors));
        } else if (harness === 'stdin_stdout') {
            normalized.push(normalizeStdinStdoutCase(rawCase, index, id, errors));
        } else {
            normalized.push({ id, weight: normalizeWeight(rawCase.weight, `cases[${index}].weight`, errors) });
        }
    }
    return normalized;
}

function normalizeFiles(rawFiles, harness, language, errors) {
    if (rawFiles === undefined || rawFiles === null) {
        if (harness === 'test_file') {
            errors.push('files must carry the driver for the test_file harness');
        }
        return null;
    }
    if (!isPlainObject(rawFiles)) {
        errors.push('files must be an object mapping relative paths to file contents');
        return null;
    }

    const paths = Object.keys(rawFiles);
    if (paths.length === 0) {
        if (harness === 'test_file') {
            errors.push('files must carry the driver for the test_file harness');
        }
        return null;
    }
    if (paths.length > LIMITS.max_files) {
        errors.push(`files must hold at most ${LIMITS.max_files} entries`);
        return null;
    }

    const normalized = {};
    // Sorted so the same authored fixture always serializes identically.
    for (const rawPath of paths.slice().sort()) {
        const pathError = filePathError(rawPath);
        if (pathError) {
            errors.push(`files path "${rawPath}" ${pathError}`);
            continue;
        }
        const contents = rawFiles[rawPath];
        if (typeof contents !== 'string') {
            errors.push(`files["${rawPath}"] must be a string`);
            continue;
        }
        if (byteLength(contents) > LIMITS.max_file_bytes) {
            errors.push(`files["${rawPath}"] exceeds ${LIMITS.max_file_bytes} bytes`);
            continue;
        }
        if (RESERVED_FILES.includes(rawPath)) {
            errors.push(`files path "${rawPath}" is reserved for the candidate code and the driver`);
            continue;
        }
        normalized[rawPath] = contents;
    }

    const entrypoint = TEST_FILE_ENTRYPOINTS[language];
    if (harness === 'test_file' && entrypoint && !has(normalized, entrypoint)) {
        errors.push(`files must carry the ${entrypoint} entrypoint for the test_file harness`);
    }
    return Object.keys(normalized).length > 0 ? normalized : null;
}

function normalizeEntry(rawFixture, harness, errors) {
    const present = has(rawFixture, 'entry') && rawFixture.entry !== null && rawFixture.entry !== undefined;

    if (harness === 'stdin_stdout') {
        if (present) errors.push('entry does not apply to the stdin_stdout harness');
        return null;
    }
    if (!present) {
        if (harness === 'function_calls') {
            errors.push('entry is required for the function_calls harness');
        }
        return null;
    }
    if (typeof rawFixture.entry !== 'string' || !IDENTIFIER.test(rawFixture.entry.trim())) {
        errors.push('entry must be an identifier');
        return null;
    }
    const entry = rawFixture.entry.trim();
    if (entry.length > LIMITS.max_id_length) {
        errors.push(`entry must be at most ${LIMITS.max_id_length} characters`);
        return null;
    }
    return entry;
}

/**
 * Validate an authored fixture and return its canonical form.
 *
 * @param {*} rawFixture the authored `reference_tests` value
 * @returns {{ valid: boolean, errors: string[], value: object|null }}
 *   `value` is the canonical fixture when valid, null otherwise. Every
 *   complaint is reported, so an author fixes one round of errors, not one.
 */
function validateReferenceTests(rawFixture) {
    const errors = [];

    if (!isPlainObject(rawFixture)) {
        return { valid: false, errors: ['reference_tests must be an object'], value: null };
    }
    rejectUnknownKeys(rawFixture, TOP_LEVEL_KEYS, 'reference_tests', errors);

    const version = has(rawFixture, 'version') ? rawFixture.version : SUPPORTED_VERSIONS[0];
    if (!SUPPORTED_VERSIONS.includes(version)) {
        errors.push(`version must be one of ${SUPPORTED_VERSIONS.join(', ')}`);
    }

    const language = has(rawFixture, 'language') ? rawFixture.language : null;
    if (!LANGUAGES.includes(language)) {
        errors.push(`language must be one of ${LANGUAGES.join(', ')}`);
    }

    const harness = has(rawFixture, 'harness') ? rawFixture.harness : null;
    if (!HARNESSES.includes(harness)) {
        // Without a harness the case and entry rules are unknown, so stop here
        // rather than reporting every field as if it were malformed.
        errors.push(`harness must be one of ${HARNESSES.join(', ')}`);
        return { valid: false, errors, value: null };
    }

    const entry = normalizeEntry(rawFixture, harness, errors);
    const timeoutMs = boundedInteger(rawFixture.timeout_ms, {
        min: LIMITS.min_timeout_ms,
        max: LIMITS.max_timeout_ms,
        fallback: LIMITS.default_timeout_ms,
        label: 'timeout_ms',
        errors
    });
    const memoryMb = boundedInteger(rawFixture.memory_mb, {
        min: 1,
        max: LIMITS.max_memory_mb,
        fallback: LIMITS.default_memory_mb,
        label: 'memory_mb',
        errors
    });
    const cases = normalizeCases(rawFixture.cases, harness, errors);
    const files = normalizeFiles(rawFixture.files, harness, language, errors);

    const totalWeight = cases.reduce((sum, testCase) => sum + testCase.weight, 0);
    if (harness !== 'test_file' && cases.length > 0 && !(totalWeight > 0)) {
        errors.push('cases must carry a positive total weight');
    }

    if (errors.length > 0) return { valid: false, errors, value: null };

    // Fixed key order: the canonical form is what gets snapshotted and, later,
    // fingerprinted, so two equal fixtures must serialize identically.
    const value = { version, language, harness };
    if (entry) value.entry = entry;
    value.timeout_ms = timeoutMs;
    value.memory_mb = memoryMb;
    value.cases = cases;
    if (files) value.files = files;

    return { valid: true, errors: [], value };
}

/**
 * Canonical fixture, or an Error carrying `code` and every complaint.
 */
function normalizeReferenceTests(rawFixture) {
    const { valid, errors, value } = validateReferenceTests(rawFixture);
    if (!valid) {
        const error = new Error(`Invalid reference_tests: ${errors.join('; ')}`);
        error.code = 'REFERENCE_TESTS_INVALID';
        error.statusCode = 400;
        error.errors = errors;
        throw error;
    }
    return value;
}

/**
 * Whether a prompt or result row carries a usable fixture. A malformed value
 * reads as absent: execution scoring is opt-in, never a half-applied contract.
 */
function hasReferenceTests(record) {
    return validateReferenceTests(record && record.reference_tests).valid;
}

/**
 * Short shape of a fixture for reports and logs. Never includes file contents
 * or case payloads.
 */
function describeReferenceTests(rawFixture) {
    const { valid, value } = validateReferenceTests(rawFixture);
    if (!valid) return null;
    return {
        version: value.version,
        language: value.language,
        harness: value.harness,
        entry: value.entry || null,
        cases: value.cases.length,
        total_weight: value.cases.reduce((sum, testCase) => sum + testCase.weight, 0),
        files: value.files ? Object.keys(value.files).length : 0,
        timeout_ms: value.timeout_ms,
        memory_mb: value.memory_mb
    };
}

module.exports = {
    HARNESSES,
    LANGUAGES,
    MATCH_MODES,
    SUPPORTED_VERSIONS,
    CANDIDATE_FILES,
    DRIVER_FILES,
    TEST_FILE_ENTRYPOINTS,
    RESERVED_FILES,
    REFERENCE_TESTS_LIMITS: LIMITS,
    validateReferenceTests,
    normalizeReferenceTests,
    hasReferenceTests,
    describeReferenceTests
};
