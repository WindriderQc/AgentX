'use strict';

const {
    validateReferenceTests,
    normalizeReferenceTests,
    hasReferenceTests,
    describeReferenceTests,
    REFERENCE_TESTS_LIMITS
} = require('../../src/services/scoring/referenceTests');

const primeFixture = () => ({
    version: 1,
    language: 'python',
    harness: 'function_calls',
    entry: 'is_prime',
    timeout_ms: 5000,
    memory_mb: 256,
    cases: [
        { id: 'n=0', args: [0], expected: false, weight: 0.5 },
        { id: 'n=2', args: [2], expected: true },
        { id: 'n=7919', args: [7919], expected: true }
    ]
});

const errorsFor = (fixture) => validateReferenceTests(fixture).errors.join(' | ');

describe('reference test fixtures', () => {
    test('accepts an authored function_calls fixture and fills the optional fields', () => {
        const { valid, errors, value } = validateReferenceTests(primeFixture());
        expect({ valid, errors }).toEqual({ valid: true, errors: [] });
        expect(value.cases.map((c) => [c.id, c.weight])).toEqual([['n=0', 0.5], ['n=2', 1], ['n=7919', 1]]);
        expect(value.entry).toBe('is_prime');
        expect(value.files).toBeUndefined();
    });

    test('defaults version, timeout and memory, and keeps a canonical key order', () => {
        const fixture = primeFixture();
        delete fixture.version;
        delete fixture.timeout_ms;
        delete fixture.memory_mb;
        const { value } = validateReferenceTests(fixture);
        expect(value.version).toBe(1);
        expect(value.timeout_ms).toBe(REFERENCE_TESTS_LIMITS.default_timeout_ms);
        expect(value.memory_mb).toBe(REFERENCE_TESTS_LIMITS.default_memory_mb);
        // Two equal fixtures must serialize identically once normalized.
        expect(Object.keys(value)).toEqual([
            'version', 'language', 'harness', 'entry', 'timeout_ms', 'memory_mb', 'cases'
        ]);
    });

    test('rejects a value that is not an object, and an unsupported version or language', () => {
        expect(validateReferenceTests(null).errors).toEqual(['reference_tests must be an object']);
        expect(validateReferenceTests('is_prime').errors).toEqual(['reference_tests must be an object']);
        expect(validateReferenceTests([primeFixture()]).errors).toEqual(['reference_tests must be an object']);
        expect(errorsFor({ ...primeFixture(), version: 2 })).toContain('version must be one of 1');
        expect(errorsFor({ ...primeFixture(), language: 'ruby' })).toContain('language must be one of');
    });

    test('stops at an unusable harness rather than reporting every dependent field', () => {
        const { valid, errors } = validateReferenceTests({ language: 'python', harness: 'shell', cases: [] });
        expect(valid).toBe(false);
        expect(errors).toEqual(['harness must be one of function_calls, stdin_stdout, test_file']);
    });

    test('reports every complaint at once so one round of fixes is enough', () => {
        const { errors } = validateReferenceTests({
            language: 'python',
            harness: 'function_calls',
            timeout_ms: 10,
            memory_mb: 4096,
            cases: [{ id: 'a', args: [1], expected: 1 }]
        });
        expect(errors).toEqual(expect.arrayContaining([
            'entry is required for the function_calls harness',
            'timeout_ms must be between 500 and 30000',
            'memory_mb must be between 1 and 512'
        ]));
    });

    test('requires an identifier entry where the harness imports one', () => {
        expect(errorsFor({ ...primeFixture(), entry: 'is prime' })).toContain('entry must be an identifier');
        expect(errorsFor({ ...primeFixture(), entry: '2fast' })).toContain('entry must be an identifier');
        expect(errorsFor({ ...primeFixture(), entry: 'os.system' })).toContain('entry must be an identifier');
        const stdio = {
            language: 'python',
            harness: 'stdin_stdout',
            entry: 'main',
            cases: [{ id: 'one', stdin: '1\n', expected_stdout: '1' }]
        };
        expect(errorsFor(stdio)).toContain('entry does not apply to the stdin_stdout harness');
        delete stdio.entry;
        expect(validateReferenceTests(stdio).valid).toBe(true);
    });

    test('rejects unknown fields on the fixture and on a case', () => {
        expect(errorsFor({ ...primeFixture(), command: 'rm -rf /' }))
            .toContain('reference_tests has unknown field "command"');
        const fixture = primeFixture();
        fixture.cases[0] = { ...fixture.cases[0], expected_stdout: 'x' };
        expect(errorsFor(fixture)).toContain('cases[0] has unknown field "expected_stdout"');
    });

    test('requires usable case ids, unique across the fixture', () => {
        const fixture = primeFixture();
        fixture.cases[1] = { args: [2], expected: true };
        expect(errorsFor(fixture)).toContain('cases[1].id is required');

        const duplicate = primeFixture();
        duplicate.cases[1].id = 'n=0';
        expect(errorsFor(duplicate)).toContain('cases[1].id duplicates an earlier case id');

        const control = primeFixture();
        control.cases[0].id = 'a\nb';
        expect(errorsFor(control)).toContain('cases[0].id must not contain control characters');
    });

    test('requires args and expected, and only values that survive JSON', () => {
        const noArgs = primeFixture();
        delete noArgs.cases[0].args;
        expect(errorsFor(noArgs)).toContain('cases[0].args is required for the function_calls harness');

        const noExpected = primeFixture();
        delete noExpected.cases[0].expected;
        expect(errorsFor(noExpected)).toContain('cases[0].expected is required for the function_calls harness');

        const notArray = primeFixture();
        notArray.cases[0].args = 0;
        expect(errorsFor(notArray)).toContain('cases[0].args must be an array');

        const nan = primeFixture();
        nan.cases[0].expected = Number.NaN;
        expect(errorsFor(nan)).toContain('cases[0].expected must be a finite number');

        const fn = primeFixture();
        fn.cases[0].args = [() => 1];
        expect(errorsFor(fn)).toContain('cases[0].args[0] must be a JSON value');

        // An expected value of null is a real expectation, not an absent field.
        const nullExpected = primeFixture();
        nullExpected.cases[0].expected = null;
        expect(validateReferenceTests(nullExpected).valid).toBe(true);
    });

    test('bounds case weights and keeps the total positive', () => {
        const negative = primeFixture();
        negative.cases[0].weight = -1;
        expect(errorsFor(negative)).toContain('cases[0].weight must be a positive number');

        const zero = primeFixture();
        zero.cases[0].weight = 0;
        expect(errorsFor(zero)).toContain('cases[0].weight must be a positive number');

        const huge = primeFixture();
        huge.cases[0].weight = REFERENCE_TESTS_LIMITS.max_weight + 1;
        expect(errorsFor(huge)).toContain('cases[0].weight must be at most 1000');
    });

    test('requires at least one case, and at most the case limit', () => {
        expect(errorsFor({ ...primeFixture(), cases: [] }))
            .toContain('cases must list at least one case for the function_calls harness');
        expect(errorsFor({ ...primeFixture(), cases: undefined }))
            .toContain('cases is required for the function_calls harness');
        expect(errorsFor({ ...primeFixture(), cases: 'all of them' })).toContain('cases must be an array');

        const tooMany = {
            ...primeFixture(),
            cases: Array.from({ length: REFERENCE_TESTS_LIMITS.max_cases + 1 }, (_, i) => ({
                id: `n=${i}`, args: [i], expected: true
            }))
        };
        expect(errorsFor(tooMany)).toContain('cases must hold at most 200 entries');
    });

    test('scores stdin_stdout cases against an expected stream under a match mode', () => {
        const fixture = {
            language: 'javascript',
            harness: 'stdin_stdout',
            cases: [
                { id: 'sum', stdin: '2 3\n', expected_stdout: '5' },
                { id: 'exact', stdin: '1\n', expected_stdout: '1\n', match: 'exact' }
            ]
        };
        const { valid, value } = validateReferenceTests(fixture);
        expect(valid).toBe(true);
        expect(value.cases.map((c) => c.match)).toEqual(['trimmed', 'exact']);

        const missing = { ...fixture, cases: [{ id: 'sum', stdin: '2 3\n' }] };
        expect(errorsFor(missing)).toContain('cases[0].expected_stdout is required for the stdin_stdout harness');

        const badMatch = { ...fixture, cases: [{ id: 'sum', stdin: '', expected_stdout: '5', match: 'fuzzy' }] };
        expect(errorsFor(badMatch)).toContain('cases[0].match must be one of trimmed, exact, tokens');

        const huge = {
            ...fixture,
            cases: [{ id: 'sum', stdin: 'x'.repeat(REFERENCE_TESTS_LIMITS.max_stream_bytes + 1), expected_stdout: '5' }]
        };
        expect(errorsFor(huge)).toContain('cases[0].stdin exceeds 65536 bytes');
    });

    test('lets a test_file fixture bring its own driver and omit cases', () => {
        const fixture = {
            language: 'python',
            harness: 'test_file',
            files: { 'test_main.py': 'import solution\n' }
        };
        const { valid, value } = validateReferenceTests(fixture);
        expect(valid).toBe(true);
        expect(value.cases).toEqual([]);
        expect(value.files).toEqual({ 'test_main.py': 'import solution\n' });

        expect(errorsFor({ language: 'python', harness: 'test_file' }))
            .toContain('files must carry the driver for the test_file harness');
        expect(errorsFor({ language: 'python', harness: 'test_file', files: {} }))
            .toContain('files must carry the driver for the test_file harness');
    });

    test('a test_file fixture must carry the entrypoint the runner will start', () => {
        expect(errorsFor({
            language: 'python', harness: 'test_file', files: { 'helper.py': 'x' }
        })).toContain('files must carry the test_main.py entrypoint for the test_file harness');
        expect(errorsFor({
            language: 'javascript', harness: 'test_file', files: { 'helper.js': 'x' }
        })).toContain('files must carry the test_main.js entrypoint for the test_file harness');
        expect(validateReferenceTests({
            language: 'javascript', harness: 'test_file', files: { 'test_main.js': 'x' }
        }).valid).toBe(true);
    });

    test('refuses a fixture file that would overwrite the candidate code or the driver', () => {
        for (const reserved of ['solution.py', 'solution.js', 'driver.py', 'driver.js', 'job.json']) {
            const fixture = { ...primeFixture(), files: { [reserved]: 'x' } };
            expect(errorsFor(fixture))
                .toContain(`files path "${reserved}" is reserved for the candidate code and the driver`);
        }
    });

    test('refuses any fixture path that could escape the job directory', () => {
        const withPath = (p) => errorsFor({
            language: 'python', harness: 'test_file', files: { [p]: 'x' }
        });
        expect(withPath('../etc/passwd')).toContain('must not contain empty, "." or ".." segments');
        expect(withPath('data/../../escape.py')).toContain('must not contain empty, "." or ".." segments');
        expect(withPath('/etc/passwd')).toContain('must be relative');
        expect(withPath('C:/Windows/system32')).toContain('must be relative');
        expect(withPath('data\\win.py')).toContain('must use forward slashes');
        expect(withPath('./local.py')).toContain('must not contain empty, "." or ".." segments');
        expect(withPath('a//b.py')).toContain('must not contain empty, "." or ".." segments');
        expect(withPath(' spaced.py ')).toContain('must not be padded with whitespace');
        expect(withPath('x'.repeat(REFERENCE_TESTS_LIMITS.max_path_length + 1))).toContain('at most 255 characters');
        expect(validateReferenceTests({
            language: 'python',
            harness: 'test_file',
            files: { 'test_main.py': 'x', 'data/cases.json': '[]' }
        }).valid).toBe(true);
    });

    test('bounds the number and size of fixture files, and sorts them', () => {
        const big = {
            language: 'python',
            harness: 'test_file',
            files: { 'test_main.py': 'x'.repeat(REFERENCE_TESTS_LIMITS.max_file_bytes + 1) }
        };
        expect(errorsFor(big)).toContain('files["test_main.py"] exceeds 65536 bytes');

        const many = { language: 'python', harness: 'test_file', files: {} };
        for (let i = 0; i <= REFERENCE_TESTS_LIMITS.max_files; i += 1) many.files[`f${i}.py`] = 'x';
        expect(errorsFor(many)).toContain('files must hold at most 32 entries');

        const notText = { language: 'python', harness: 'test_file', files: { 'test_main.py': 42 } };
        expect(errorsFor(notText)).toContain('files["test_main.py"] must be a string');

        const unsorted = {
            language: 'python',
            harness: 'test_file',
            files: { 'z.py': 'z', 'test_main.py': 'm', 'a.py': 'a' }
        };
        expect(Object.keys(validateReferenceTests(unsorted).value.files))
            .toEqual(['a.py', 'test_main.py', 'z.py']);
    });

    test('normalizeReferenceTests throws one error carrying every complaint', () => {
        expect(normalizeReferenceTests(primeFixture())).toEqual(validateReferenceTests(primeFixture()).value);
        let thrown = null;
        try {
            normalizeReferenceTests({ language: 'python', harness: 'function_calls', cases: [] });
        } catch (error) {
            thrown = error;
        }
        expect(thrown).not.toBeNull();
        expect(thrown.code).toBe('REFERENCE_TESTS_INVALID');
        expect(thrown.statusCode).toBe(400);
        expect(thrown.errors.length).toBeGreaterThan(1);
        expect(thrown.message).toContain('entry is required');
    });

    test('a malformed fixture reads as absent, never as a half-applied contract', () => {
        expect(hasReferenceTests({ reference_tests: primeFixture() })).toBe(true);
        expect(hasReferenceTests({ reference_tests: { harness: 'function_calls' } })).toBe(false);
        expect(hasReferenceTests({})).toBe(false);
        expect(hasReferenceTests(null)).toBe(false);
    });

    test('describes a fixture without leaking case payloads or file contents', () => {
        expect(describeReferenceTests(primeFixture())).toEqual({
            version: 1,
            language: 'python',
            harness: 'function_calls',
            entry: 'is_prime',
            cases: 3,
            total_weight: 2.5,
            files: 0,
            timeout_ms: 5000,
            memory_mb: 256
        });
        expect(describeReferenceTests({ harness: 'nope' })).toBeNull();
    });
});
