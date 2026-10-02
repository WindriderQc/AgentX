'use strict';

const { buildExecutionJob, COMMANDS, PROTOCOL } = require('../../src/services/scoring/executionHarness');
const { CANDIDATE_FILES, DRIVER_FILES, TEST_FILE_ENTRYPOINTS } = require('../../src/services/scoring/referenceTests');

const prime = (language = 'python') => ({
    language,
    harness: 'function_calls',
    entry: language === 'python' ? 'is_prime' : 'isPrime',
    cases: [
        { id: 'n=0', args: [0], expected: false, weight: 0.5 },
        { id: 'n=2', args: [2], expected: true },
        { id: 'quote', args: ['it\'s "x"'], expected: null }
    ]
});

describe('building a sandbox job', () => {
    test('lays out the candidate, the generated driver and the budgets', () => {
        const job = buildExecutionJob({ fixture: prime(), code: 'def is_prime(n):\n    return n > 1' });
        expect(job).toMatchObject({
            language: 'python',
            harness: 'function_calls',
            command: COMMANDS.python,
            args: [DRIVER_FILES.python],
            timeout_ms: 5000,
            memory_mb: 256,
            protocol: PROTOCOL
        });
        expect(Object.keys(job.files).sort()).toEqual([DRIVER_FILES.python, CANDIDATE_FILES.python].sort());
        expect(job.files[CANDIDATE_FILES.python]).toBe('def is_prime(n):\n    return n > 1\n');
    });

    test('carries the cases into the driver without escape sequences, base64 encoded', () => {
        const job = buildExecutionJob({ fixture: prime(), code: 'x = 1' });
        const driver = job.files[DRIVER_FILES.python];
        const encoded = /b64decode\("([A-Za-z0-9+/=]+)"\)/.exec(driver)[1];
        const cases = JSON.parse(Buffer.from(encoded, 'base64').toString('utf8'));
        expect(cases).toEqual([
            { id: 'n=0', args: [0], expected: false },
            { id: 'n=2', args: [2], expected: true },
            { id: 'quote', args: ['it\'s "x"'], expected: null }
        ]);
        expect(driver).toContain('ENTRY = "is_prime"');
        expect(driver).toContain('import solution');
        expect(driver).toContain('emit("LOAD_ERROR"');
        expect(driver).toContain('emit("RESULT"');
        // The driver never contains a backslash: no escape can mean something
        // different in the sandbox than it does here.
        expect(driver).not.toContain('\\');
    });

    test('builds the javascript driver around a vm context and the entry probe', () => {
        const job = buildExecutionJob({ fixture: prime('javascript'), code: 'const isPrime = (n) => n > 1;' });
        expect(job.command).toBe('node');
        expect(job.args).toEqual([DRIVER_FILES.javascript]);
        const driver = job.files[DRIVER_FILES.javascript];
        expect(driver).toContain('const ENTRY = "isPrime";');
        expect(driver).toContain('vm.runInContext');
        expect(driver).toContain('typeof isPrime');
        expect(driver).toContain("emit('LOAD_ERROR'");
        expect(job.files[CANDIDATE_FILES.javascript]).toBe('const isPrime = (n) => n > 1;\n');
    });

    test('builds stdin_stdout drivers that spawn the candidate per case within the budget', () => {
        const fixture = {
            language: 'python',
            harness: 'stdin_stdout',
            timeout_ms: 2500,
            cases: [{ id: 'sum', stdin: '2 3\n', expected_stdout: '5' }]
        };
        const python = buildExecutionJob({ fixture, code: 'print(sum(map(int, input().split())))' });
        expect(python.files[DRIVER_FILES.python]).toContain('BUDGET = 2.500');
        expect(python.files[DRIVER_FILES.python]).toContain('subprocess.run([sys.executable, "solution.py"]');

        const node = buildExecutionJob({
            fixture: { ...fixture, language: 'javascript' },
            code: 'process.stdout.write("5")'
        });
        expect(node.files[DRIVER_FILES.javascript]).toContain('const BUDGET_MS = 2500;');
        expect(node.files[DRIVER_FILES.javascript]).toContain('spawnSync(process.execPath');
    });

    test('runs a test_file fixture through its own entrypoint beside the candidate', () => {
        const fixture = {
            language: 'javascript',
            harness: 'test_file',
            files: { 'test_main.js': 'require("./solution.js");', 'data/in.txt': '1' }
        };
        const job = buildExecutionJob({ fixture, code: 'module.exports = 1;' });
        expect(job.args).toEqual([TEST_FILE_ENTRYPOINTS.javascript]);
        expect(Object.keys(job.files).sort()).toEqual(['data/in.txt', 'solution.js', 'test_main.js']);
        expect(job.files['test_main.js']).toBe('require("./solution.js");');
    });

    test('refuses an invalid fixture or empty code before anything is materialized', () => {
        expect(() => buildExecutionJob({ fixture: { harness: 'function_calls' }, code: 'x' }))
            .toThrow(/Invalid reference_tests/);
        expect(() => buildExecutionJob({ fixture: prime(), code: '   ' }))
            .toThrow(/without candidate code/);
    });
});
