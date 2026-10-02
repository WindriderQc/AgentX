'use strict';

/**
 * Turn a reference-test fixture and a candidate's program into one sandbox
 * job: the files to materialize, the command to run, and the budgets.
 *
 * The generated driver speaks a one-line protocol on standard output:
 *
 *   RESULT {"id": "<case id>", "passed": true|false, ...}
 *   LOAD_ERROR {"error": "..."}
 *
 * Everything the candidate itself prints is diverted to standard error, so a
 * `print` in a solution cannot collide with the protocol stream. The scorer
 * (`executionScore.js`) reads only these two tags and ignores every other
 * line.
 *
 * Pure: builds text, never writes a file or spawns a process. The runner
 * client materializes the job; a fake runner in tests reads it as data.
 *
 * Driver sources are assembled from plain string lines with no escape
 * sequences, so what the sandbox executes is exactly what is readable here.
 */

const {
    CANDIDATE_FILES,
    DRIVER_FILES,
    TEST_FILE_ENTRYPOINTS,
    normalizeReferenceTests
} = require('./referenceTests');

const COMMANDS = Object.freeze({ python: 'python3', javascript: 'node' });
const PROTOCOL = Object.freeze({ result_tag: 'RESULT', load_error_tag: 'LOAD_ERROR' });

function base64Json(value) {
    return Buffer.from(JSON.stringify(value), 'utf8').toString('base64');
}

function pythonFunctionCallsDriver(fixture) {
    const cases = base64Json(fixture.cases.map((c) => ({ id: c.id, args: c.args, expected: c.expected })));
    return [
        'import base64, json, sys, traceback',
        '',
        'NL = chr(10)',
        'CASES = json.loads(base64.b64decode("' + cases + '").decode("utf-8"))',
        'ENTRY = "' + fixture.entry + '"',
        'REAL_STDOUT = sys.stdout',
        '# The candidate may print; that must not reach the protocol stream.',
        'sys.stdout = sys.stderr',
        'sys.setrecursionlimit(10000)',
        '',
        'def emit(tag, payload):',
        '    REAL_STDOUT.write(tag + " " + json.dumps(payload, ensure_ascii=True, default=repr) + NL)',
        '    REAL_STDOUT.flush()',
        '',
        'def plain(value):',
        '    if isinstance(value, (tuple, list)):',
        '        return [plain(v) for v in value]',
        '    if isinstance(value, dict):',
        '        return {str(k): plain(v) for k, v in value.items()}',
        '    if isinstance(value, (set, frozenset)):',
        '        return sorted([plain(v) for v in value], key=repr)',
        '    return value',
        '',
        'def same(actual, expected):',
        '    actual = plain(actual)',
        '    if isinstance(expected, bool) or isinstance(actual, bool):',
        '        return isinstance(actual, bool) and isinstance(expected, bool) and actual == expected',
        '    if isinstance(expected, (int, float)) and isinstance(actual, (int, float)):',
        '        if isinstance(expected, float) or isinstance(actual, float):',
        '            return abs(actual - expected) <= 1e-9 * max(1.0, abs(expected))',
        '        return actual == expected',
        '    if isinstance(expected, list):',
        '        return isinstance(actual, list) and len(actual) == len(expected) and all(same(a, e) for a, e in zip(actual, expected))',
        '    if isinstance(expected, dict):',
        '        return isinstance(actual, dict) and set(actual.keys()) == set(expected.keys()) and all(same(actual[k], expected[k]) for k in expected)',
        '    return type(actual) == type(expected) and actual == expected',
        '',
        'def describe(value):',
        '    try:',
        '        return json.dumps(plain(value), ensure_ascii=True, default=repr)[:500]',
        '    except Exception:',
        '        return repr(value)[:500]',
        '',
        'try:',
        '    import solution',
        'except BaseException:',
        '    emit("LOAD_ERROR", {"error": traceback.format_exc(limit=5)[-2000:]})',
        '    sys.exit(3)',
        '',
        'target = getattr(solution, ENTRY, None)',
        'if not callable(target):',
        '    emit("LOAD_ERROR", {"error": "entry " + ENTRY + " is not defined or not callable"})',
        '    sys.exit(3)',
        '',
        'failed = 0',
        'for case in CASES:',
        '    ok = False',
        '    try:',
        '        actual = target(*case["args"])',
        '        ok = same(actual, case["expected"])',
        '        emit("RESULT", {"id": case["id"], "passed": bool(ok), "actual": None if ok else describe(actual)})',
        '    except BaseException as exc:',
        '        emit("RESULT", {"id": case["id"], "passed": False, "error": (type(exc).__name__ + ": " + str(exc))[:500]})',
        '    if not ok:',
        '        failed += 1',
        'sys.exit(0 if failed == 0 else 1)',
        ''
    ].join('\n');
}

function javascriptFunctionCallsDriver(fixture) {
    const cases = base64Json(fixture.cases.map((c) => ({ id: c.id, args: c.args, expected: c.expected })));
    const entry = fixture.entry;
    return [
        "'use strict';",
        "const fs = require('fs');",
        "const path = require('path');",
        "const vm = require('vm');",
        '',
        'const NL = String.fromCharCode(10);',
        'const CASES = JSON.parse(Buffer.from("' + cases + '", "base64").toString("utf8"));',
        'const ENTRY = "' + entry + '";',
        '',
        'function emit(tag, payload) {',
        "    fs.writeSync(1, tag + ' ' + JSON.stringify(payload) + NL);",
        '}',
        '// The candidate may log; that must not reach the protocol stream.',
        'const quiet = new console.Console({ stdout: process.stderr, stderr: process.stderr });',
        '',
        'function plain(value) {',
        '    if (value instanceof Map) {',
        '        const out = {};',
        '        for (const [k, v] of value.entries()) out[String(k)] = plain(v);',
        '        return out;',
        '    }',
        '    if (value instanceof Set) {',
        '        return Array.from(value, plain).sort((a, b) => (JSON.stringify(a) < JSON.stringify(b) ? -1 : 1));',
        '    }',
        '    if (Array.isArray(value)) return value.map(plain);',
        "    if (value && typeof value === 'object') {",
        '        const out = {};',
        '        for (const k of Object.keys(value)) out[k] = plain(value[k]);',
        '        return out;',
        '    }',
        '    return value;',
        '}',
        '',
        'function same(actual, expected) {',
        '    actual = plain(actual);',
        "    if (typeof expected === 'number') {",
        "        if (typeof actual !== 'number' || Number.isNaN(actual)) return false;",
        '        if (Number.isInteger(expected) && Number.isInteger(actual)) return actual === expected;',
        '        return Math.abs(actual - expected) <= 1e-9 * Math.max(1, Math.abs(expected));',
        '    }',
        "    if (expected === null || typeof expected !== 'object') return actual === expected;",
        '    if (Array.isArray(expected)) {',
        '        return Array.isArray(actual) && actual.length === expected.length',
        '            && expected.every((e, i) => same(actual[i], e));',
        '    }',
        "    if (!actual || typeof actual !== 'object' || Array.isArray(actual)) return false;",
        '    const expectedKeys = Object.keys(expected).sort();',
        '    const actualKeys = Object.keys(actual).sort();',
        '    return expectedKeys.length === actualKeys.length',
        '        && expectedKeys.every((k, i) => k === actualKeys[i] && same(actual[k], expected[k]));',
        '}',
        '',
        'function describe(value) {',
        '    try { return String(JSON.stringify(plain(value))).slice(0, 500); } catch (e) { return String(value).slice(0, 500); }',
        '}',
        '',
        "const source = fs.readFileSync(path.join(__dirname, 'solution.js'), 'utf8');",
        'const sandboxModule = { exports: {} };',
        'const context = vm.createContext({',
        '    module: sandboxModule, exports: sandboxModule.exports, require, console: quiet,',
        "    process: { env: {}, argv: [], exit() { throw new Error('process.exit is not available'); } },",
        '    setTimeout, clearTimeout, setInterval, clearInterval, Buffer, URL, TextEncoder, TextDecoder',
        '});',
        '',
        'let target;',
        'try {',
        "    const probe = ';globalThis.__entry__ = (typeof " + entry + " === \"undefined\") ? undefined : " + entry + ";';",
        "    vm.runInContext(source + NL + probe, context, { filename: 'solution.js' });",
        '    const exported = sandboxModule.exports;',
        '    target = context.__entry__',
        '        || (exported && exported[ENTRY])',
        "        || (typeof exported === 'function' && exported.name === ENTRY ? exported : undefined);",
        '} catch (error) {',
        "    emit('LOAD_ERROR', { error: String((error && error.stack) || error).slice(0, 2000) });",
        '    process.exit(3);',
        '}',
        "if (typeof target !== 'function') {",
        "    emit('LOAD_ERROR', { error: 'entry ' + ENTRY + ' is not defined or not a function' });",
        '    process.exit(3);',
        '}',
        '',
        '(async () => {',
        '    let failed = 0;',
        '    for (const c of CASES) {',
        '        let ok = false;',
        '        try {',
        '            const actual = await target(...c.args);',
        '            ok = same(actual, c.expected);',
        "            emit('RESULT', { id: c.id, passed: ok, actual: ok ? null : describe(actual) });",
        '        } catch (error) {',
        "            emit('RESULT', { id: c.id, passed: false, error: String((error && error.message) || error).slice(0, 500) });",
        '        }',
        '        if (!ok) failed += 1;',
        '    }',
        '    process.exit(failed === 0 ? 0 : 1);',
        '})();',
        ''
    ].join('\n');
}

function pythonStdinStdoutDriver(fixture) {
    const cases = base64Json(fixture.cases.map((c) => ({
        id: c.id, stdin: c.stdin, expected_stdout: c.expected_stdout, match: c.match
    })));
    return [
        'import base64, json, subprocess, sys, time',
        '',
        'NL = chr(10)',
        'CR = chr(13)',
        'CASES = json.loads(base64.b64decode("' + cases + '").decode("utf-8"))',
        'BUDGET = ' + (fixture.timeout_ms / 1000).toFixed(3),
        'REAL_STDOUT = sys.stdout',
        'sys.stdout = sys.stderr',
        '',
        'def emit(tag, payload):',
        '    REAL_STDOUT.write(tag + " " + json.dumps(payload, ensure_ascii=True, default=repr) + NL)',
        '    REAL_STDOUT.flush()',
        '',
        'def normalize(text, mode):',
        '    text = text.replace(CR + NL, NL)',
        '    if mode == "exact":',
        '        return text',
        '    if mode == "tokens":',
        '        return text.split()',
        '    return text.strip()',
        '',
        'started = time.monotonic()',
        'failed = 0',
        'for case in CASES:',
        '    ok = False',
        '    remaining = BUDGET - (time.monotonic() - started)',
        '    if remaining <= 0.05:',
        '        emit("RESULT", {"id": case["id"], "passed": False, "error": "job budget exhausted"})',
        '        failed += 1',
        '        continue',
        '    try:',
        '        run = subprocess.run([sys.executable, "solution.py"], input=case["stdin"], capture_output=True, text=True, timeout=remaining)',
        '        ok = run.returncode == 0 and normalize(run.stdout, case["match"]) == normalize(case["expected_stdout"], case["match"])',
        '        payload = {"id": case["id"], "passed": bool(ok)}',
        '        if not ok:',
        '            payload["actual"] = run.stdout[:500]',
        '            payload["exit_code"] = run.returncode',
        '            if run.stderr:',
        '                payload["error"] = run.stderr[-500:]',
        '        emit("RESULT", payload)',
        '    except subprocess.TimeoutExpired:',
        '        emit("RESULT", {"id": case["id"], "passed": False, "error": "timeout"})',
        '    if not ok:',
        '        failed += 1',
        'sys.exit(0 if failed == 0 else 1)',
        ''
    ].join('\n');
}

function javascriptStdinStdoutDriver(fixture) {
    const cases = base64Json(fixture.cases.map((c) => ({
        id: c.id, stdin: c.stdin, expected_stdout: c.expected_stdout, match: c.match
    })));
    return [
        "'use strict';",
        "const fs = require('fs');",
        "const path = require('path');",
        "const { spawnSync } = require('child_process');",
        '',
        'const NL = String.fromCharCode(10);',
        'const CR = String.fromCharCode(13);',
        'const CASES = JSON.parse(Buffer.from("' + cases + '", "base64").toString("utf8"));',
        'const BUDGET_MS = ' + fixture.timeout_ms + ';',
        '',
        'function emit(tag, payload) {',
        "    fs.writeSync(1, tag + ' ' + JSON.stringify(payload) + NL);",
        '}',
        '',
        'function normalize(text, mode) {',
        '    text = String(text).split(CR + NL).join(NL);',
        "    if (mode === 'exact') return text;",
        "    if (mode === 'tokens') return text.split(/\\s+/).filter(Boolean).join(' ');",
        '    return text.trim();',
        '}',
        '',
        'const started = Date.now();',
        'let failed = 0;',
        'for (const c of CASES) {',
        '    let ok = false;',
        '    const remaining = BUDGET_MS - (Date.now() - started);',
        '    if (remaining <= 50) {',
        "        emit('RESULT', { id: c.id, passed: false, error: 'job budget exhausted' });",
        '        failed += 1;',
        '        continue;',
        '    }',
        "    const run = spawnSync(process.execPath, [path.join(__dirname, 'solution.js')], {",
        "        input: c.stdin, encoding: 'utf8', timeout: remaining, cwd: __dirname, maxBuffer: 1024 * 1024",
        '    });',
        "    if (run.error && run.error.code === 'ETIMEDOUT') {",
        "        emit('RESULT', { id: c.id, passed: false, error: 'timeout' });",
        '    } else {',
        '        ok = run.status === 0 && normalize(run.stdout, c.match) === normalize(c.expected_stdout, c.match);',
        '        const payload = { id: c.id, passed: ok };',
        '        if (!ok) {',
        "            payload.actual = String(run.stdout || '').slice(0, 500);",
        '            payload.exit_code = run.status;',
        "            if (run.stderr) payload.error = String(run.stderr).slice(-500);",
        '        }',
        "        emit('RESULT', payload);",
        '    }',
        '    if (!ok) failed += 1;',
        '}',
        'process.exit(failed === 0 ? 0 : 1);',
        ''
    ].join('\n');
}

const DRIVERS = Object.freeze({
    function_calls: { python: pythonFunctionCallsDriver, javascript: javascriptFunctionCallsDriver },
    stdin_stdout: { python: pythonStdinStdoutDriver, javascript: javascriptStdinStdoutDriver }
});

/**
 * Build the sandbox job for one candidate.
 *
 * @param {{ fixture: object, code: string }} input the authored fixture
 *   (raw or canonical) and the program extracted from the response
 * @returns {{ language, harness, command, args, timeout_ms, memory_mb, files, protocol }}
 *   `files` maps relative paths to contents: the candidate under its reserved
 *   name, the generated driver (or the fixture's own entrypoint for
 *   `test_file`), and any fixture files.
 */
function buildExecutionJob({ fixture: rawFixture, code }) {
    const fixture = normalizeReferenceTests(rawFixture);
    if (typeof code !== 'string' || code.trim() === '') {
        const error = new Error('Cannot build an execution job without candidate code');
        error.code = 'EXECUTION_JOB_NO_CODE';
        throw error;
    }

    const { language, harness } = fixture;
    const files = { ...(fixture.files || {}) };
    files[CANDIDATE_FILES[language]] = code.endsWith('\n') ? code : code + '\n';

    let entrypoint;
    if (harness === 'test_file') {
        entrypoint = TEST_FILE_ENTRYPOINTS[language];
    } else {
        entrypoint = DRIVER_FILES[language];
        files[entrypoint] = DRIVERS[harness][language](fixture);
    }

    return {
        language,
        harness,
        command: COMMANDS[language],
        args: [entrypoint],
        timeout_ms: fixture.timeout_ms,
        memory_mb: fixture.memory_mb,
        files,
        protocol: { ...PROTOCOL }
    };
}

module.exports = {
    COMMANDS,
    PROTOCOL,
    buildExecutionJob
};
