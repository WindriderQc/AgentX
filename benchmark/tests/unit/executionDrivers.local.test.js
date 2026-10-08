'use strict';

/**
 * Runs the generated drivers with the interpreters installed on this machine.
 * This is the only place the driver text is executed before the sandbox
 * exists, so it is opt-in: set BENCHMARK_DRIVER_SMOKE=1 to run it. It spawns
 * processes and writes to a temp directory; the ordinary unit run stays pure.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const { extractCode } = require('../../src/services/scoring/codeExtractor');
const { buildExecutionJob } = require('../../src/services/scoring/executionHarness');
const { scoreExecution } = require('../../src/services/scoring/executionScore');

const enabled = process.env.BENCHMARK_DRIVER_SMOKE === '1';
const describeLocal = enabled ? describe : describe.skip;

function resolveInterpreter(command) {
    // On Windows, `python3` is often the Store alias, which cannot start a
    // child interpreter without the user profile; a plain `python` can.
    const pythons = process.platform === 'win32' ? ['python', 'python3', 'py'] : ['python3', 'python'];
    const candidates = command === 'python3' ? pythons : [command];
    for (const candidate of candidates) {
        const probe = spawnSync(candidate, ['--version'], { encoding: 'utf8' });
        if (!probe.error && probe.status === 0) return candidate;
    }
    return null;
}

/**
 * The local stand-in for the sidecar: materialize the job in a temp directory
 * and run it. It reports the same shape the runner client will.
 */
function runLocally(job) {
    const command = resolveInterpreter(job.command);
    if (!command) return { status: 'runner_unavailable', error: `${job.command} not installed` };

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentx-driver-'));
    try {
        for (const [relative, contents] of Object.entries(job.files)) {
            const target = path.join(dir, relative);
            fs.mkdirSync(path.dirname(target), { recursive: true });
            fs.writeFileSync(target, contents, 'utf8');
        }
        const started = Date.now();
        const run = spawnSync(command, job.args, {
            cwd: dir, encoding: 'utf8', timeout: job.timeout_ms + 1000, maxBuffer: 1024 * 1024,
            // This is the local stand-in, not the sandbox: the interpreter keeps
            // what it needs from the host to start (profile paths on Windows).
            env: {
                PATH: process.env.PATH,
                SYSTEMROOT: process.env.SYSTEMROOT || '',
                LOCALAPPDATA: process.env.LOCALAPPDATA || '',
                APPDATA: process.env.APPDATA || '',
                USERPROFILE: process.env.USERPROFILE || dir,
                TEMP: process.env.TEMP || dir,
                TMP: process.env.TMP || dir,
                HOME: dir,
                LANG: 'C.UTF-8'
            }
        });
        return {
            exit_code: run.status,
            timed_out: !!(run.error && run.error.code === 'ETIMEDOUT'),
            stdout: run.stdout || '',
            stderr: run.stderr || '',
            duration_ms: Date.now() - started,
            stdout_truncated: false
        };
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
}

function execute(fixture, response) {
    const extraction = extractCode(response, { language: fixture.language, entry: fixture.entry || null });
    const job = buildExecutionJob({ fixture, code: extraction.status === 'ok' ? extraction.code : 'pass' });
    const run = runLocally(job);
    return scoreExecution({ fixture, extraction, run });
}

const lines = (...parts) => parts.join('\n');
const FENCE = '```';

const primePython = {
    language: 'python',
    harness: 'function_calls',
    entry: 'is_prime',
    cases: [
        { id: 'n=0', args: [0], expected: false, weight: 0.5 },
        { id: 'n=1', args: [1], expected: false, weight: 0.5 },
        { id: 'n=2', args: [2], expected: true },
        { id: 'n=9', args: [9], expected: false },
        { id: 'n=97', args: [97], expected: true },
        { id: 'n=7919', args: [7919], expected: true }
    ]
};

// The judge calibration set's four coding responses (issue #7): the judge
// scored the two correct-but-plain ones 0.4 to 5.8. Execution must give the
// three correct functions 10 and the wrong one 0.
const CALIBRATION = {
    excellent: lines(
        FENCE + 'python',
        'def is_prime(n: int) -> bool:',
        '    """Check if n is a prime number."""',
        '    if n < 2:',
        '        return False',
        '    if n < 4:',
        '        return True',
        '    if n % 2 == 0 or n % 3 == 0:',
        '        return False',
        '    i = 5',
        '    while i * i <= n:',
        '        if n % i == 0 or n % (i + 2) == 0:',
        '            return False',
        '        i += 6',
        '    return True',
        FENCE
    ),
    good: lines(
        'def is_prime(n):',
        '    if n < 2:',
        '        return False',
        '    if n < 4:',
        '        return True',
        '    if n % 2 == 0:',
        '        return False',
        '    for i in range(3, int(n**0.5) + 1, 2):',
        '        if n % i == 0:',
        '            return False',
        '    return True'
    ),
    linear: lines(
        'def is_prime(n):',
        '    if n < 2:',
        '        return False',
        '    for i in range(2, n):',
        '        if n % i == 0:',
        '            return False',
        '    return True'
    )
};

describeLocal('generated drivers, executed locally', () => {
    test('python function_calls: the three correct prime functions pass, however plain', () => {
        for (const [name, response] of Object.entries(CALIBRATION)) {
            const execution = execute(primePython, response);
            expect({ name, status: execution.status, correctness: execution.correctness, cases: execution.cases })
                .toEqual({ name, status: 'passed', correctness: 10, cases: expect.any(Array) });
        }
    });

    test('python function_calls: a wrong function fails with the failing cases named', () => {
        const reverse = {
            language: 'python',
            harness: 'function_calls',
            entry: 'reverse_string',
            cases: [
                { id: 'empty', args: [''], expected: '' },
                { id: 'abc', args: ['abc'], expected: 'cba' },
                { id: 'palindrome', args: ['aba'], expected: 'aba' }
            ]
        };
        const execution = execute(reverse, lines('def reverse_string(s):', '    return s'));
        expect(execution.status).toBe('failed');
        expect(execution.cases.map((c) => [c.id, c.passed])).toEqual([['empty', true], ['abc', false], ['palindrome', true]]);
        expect(execution.cases[1].actual).toBe('"abc"');
        expect(execution.correctness).toBe(0.7);
    });

    test('python: printing, wrong types, exceptions and a missing entry are all reported cleanly', () => {
        const noisy = execute(primePython, lines(
            'print("loading")',
            'def is_prime(n):',
            '    print("checking", n)',
            '    return 1 if n in (2, 97, 7919) else 0'
        ));
        // Ints are not the booleans the fixture expects, and prints never reach the protocol.
        expect(noisy.status).toBe('failed');
        expect(noisy.passed).toBe(0);
        expect(noisy.cases[0].actual).toBe('0');

        const raises = execute(primePython, lines('def is_prime(n):', '    raise ValueError("nope")'));
        expect(raises.status).toBe('failed');
        expect(raises.cases[0].error).toBe('ValueError: nope');

        const syntax = execute(primePython, lines('def is_prime(n)', '    return True'));
        expect(syntax.status).toBe('compile_error');
        expect(syntax.detail).toContain('SyntaxError');

        const wrongName = execute(primePython, lines('def prime(n):', '    return True'));
        expect(wrongName.status).toBe('compile_error');
        expect(wrongName.detail).toContain('is_prime is not defined');
    });

    test('python: an infinite loop is a timeout, not a hang', () => {
        const fixture = { ...primePython, timeout_ms: 1500 };
        const execution = execute(fixture, lines('def is_prime(n):', '    while True:', '        pass'));
        expect(execution.status).toBe('timeout');
        expect(execution.correctness).toBe(0);
    });

    test('javascript function_calls: declarations, exports and async functions all resolve', () => {
        const fixture = { ...primePython, language: 'javascript', entry: 'isPrime' };
        const forms = [
            lines('function isPrime(n) {', '  if (n < 2) return false;', '  for (let i = 2; i * i <= n; i++) if (n % i === 0) return false;', '  return true;', '}'),
            lines('const isPrime = (n) => {', '  if (n < 2) return false;', '  for (let i = 2; i * i <= n; i++) if (n % i === 0) return false;', '  return true;', '};'),
            lines('async function isPrime(n) {', '  if (n < 2) return false;', '  for (let i = 2; i * i <= n; i++) if (n % i === 0) return false;', '  return true;', '}'),
            lines('function check(n) {', '  if (n < 2) return false;', '  for (let i = 2; i * i <= n; i++) if (n % i === 0) return false;', '  return true;', '}', 'module.exports = { isPrime: check };')
        ];
        for (const response of forms) {
            const execution = execute(fixture, response);
            expect({ response, status: execution.status, correctness: execution.correctness })
                .toEqual({ response, status: 'passed', correctness: 10 });
        }
        const wrong = execute(fixture, 'const isPrime = (n) => n > 1;');
        expect(wrong.status).toBe('failed');
        expect(wrong.cases.find((c) => c.id === 'n=9').passed).toBe(false);
        expect(wrong.cases.find((c) => c.id === 'n=9').actual).toBe('true');

        const missing = execute(fixture, 'const prime = (n) => n > 1;');
        expect(missing.status).toBe('compile_error');
        expect(missing.detail).toContain('isPrime is not defined');
    });

    test('stdin_stdout in both languages compares output under the match mode', () => {
        const cases = [
            { id: 'sum', stdin: '2 3\n', expected_stdout: '5' },
            { id: 'sum-tokens', stdin: '10 20\n', expected_stdout: '  30  ', match: 'tokens' },
            { id: 'sum-exact', stdin: '1 1\n', expected_stdout: '2\n', match: 'exact' }
        ];
        const python = execute(
            { language: 'python', harness: 'stdin_stdout', cases },
            lines('a, b = map(int, input().split())', 'print(a + b)')
        );
        expect(python.status).toBe('passed');

        const node = execute(
            { language: 'javascript', harness: 'stdin_stdout', cases },
            lines(
                "const [a, b] = require('fs').readFileSync(0, 'utf8').trim().split(/\\s+/).map(Number);",
                'console.log(a + b);'
            )
        );
        expect(node.status).toBe('passed');

        const wrong = execute(
            { language: 'python', harness: 'stdin_stdout', cases },
            lines('a, b = map(int, input().split())', 'print(a * b)')
        );
        expect(wrong.status).toBe('failed');
        expect(wrong.cases.map((c) => c.passed)).toEqual([false, false, false]);
        expect(wrong.cases[0].actual.trim()).toBe('6');
    });

    test('test_file: the fixture driver decides, with or without RESULT lines', () => {
        const silent = execute({
            language: 'python',
            harness: 'test_file',
            files: { 'test_main.py': lines('import solution', 'assert solution.is_prime(7)', 'assert not solution.is_prime(8)') }
        }, CALIBRATION.good);
        expect(silent).toMatchObject({ status: 'passed', correctness: 10 });

        const reporting = execute({
            language: 'javascript',
            harness: 'test_file',
            cases: [{ id: 'seven' }, { id: 'eight' }],
            files: {
                'test_main.js': lines(
                    "const s = require('./solution.js');",
                    "console.log('RESULT ' + JSON.stringify({ id: 'seven', passed: s.isPrime(7) === true }));",
                    "console.log('RESULT ' + JSON.stringify({ id: 'eight', passed: s.isPrime(8) === false }));"
                )
            }
        }, 'module.exports = { isPrime: (n) => n > 1 };');
        expect(reporting).toMatchObject({ status: 'failed', passed: 1, failed: 1, correctness: 0.5 });
        expect(reporting.cases.map((c) => [c.id, c.passed])).toEqual([['seven', true], ['eight', false]]);
    });

    test('test_file: CommonJS examples do not turn valid modules into execution failures', () => {
        const fixture = { language: 'javascript', harness: 'test_file', files: {
            'test_main.js': lines("const assert = require('assert');", "const { increment } = require('./solution');",
                'assert.strictEqual(increment(2), 3);', 'assert.strictEqual(increment(-1), 0);')
        } };
        const solution = 'const increment = n => n + 1;\nmodule.exports = { increment };';
        const fenced = lines(FENCE + 'js', solution, FENCE);
        const examples = [
            lines('Usage:', FENCE + 'js', "const { increment } = require('./counter');", 'increment(2);', FENCE),
            lines('Example production wiring:', FENCE + 'js', "require('illustrated-client');", FENCE)
        ];
        for (const response of [solution, fenced, ...examples.map(example => lines(fenced, example))]) {
            expect(execute(fixture, response)).toMatchObject({ status: 'passed', correctness: 10 });
        }
        expect(execute(fixture, lines(fenced.replace('n + 1', 'n + 2'), examples[0])))
            .toMatchObject({ status: 'failed', correctness: 0 });
        expect(execute(fixture, lines(fenced, FENCE + 'js', "require('missing-module');", FENCE)))
            .toMatchObject({ status: 'failed', correctness: 0 });
    });
});
