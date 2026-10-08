'use strict';

const { extractCode, definesEntry, startsProgram } = require('../../src/services/scoring/codeExtractor');

const lines = (...parts) => parts.join('\n');
const FENCE = '```';

// The four coding responses in the judge calibration set: one fenced, three
// raw. Both shapes have to reach the runner intact.
const CALIBRATION = {
    excellent: lines(
        FENCE + 'python',
        'def is_prime(n: int) -> bool:',
        '    """Check if n is a prime number."""',
        '    if n < 2:',
        '        return False',
        '    i = 5',
        '    while i * i <= n:',
        '        if n % i == 0:',
        '            return False',
        '        i += 6',
        '    return True',
        FENCE
    ),
    good: lines(
        'def is_prime(n):',
        '    if n < 2:',
        '        return False',
        '    for i in range(3, int(n**0.5) + 1, 2):',
        '        if n % i == 0:',
        '            return False',
        '    return True'
    ),
    wrong: lines(
        'def reverse_string(s):',
        '    return s'
    )
};

describe('extracting a program from a model response', () => {
    test('takes a tagged fenced block and drops the fence', () => {
        const result = extractCode(CALIBRATION.excellent, { language: 'python', entry: 'is_prime' });
        expect(result.status).toBe('ok');
        expect(result.source).toBe('fenced');
        expect(result.blocks).toBe(1);
        expect(result.code.startsWith('def is_prime(n: int) -> bool:')).toBe(true);
        expect(result.code).not.toContain(FENCE);
        expect(result.code.trimEnd().endsWith('return True')).toBe(true);
    });

    test('accepts raw code that is the whole response', () => {
        for (const response of [CALIBRATION.good, CALIBRATION.wrong]) {
            const result = extractCode(response, { language: 'python', entry: 'is_prime' });
            expect(result.status).toBe('ok');
            expect(result.source).toBe('raw');
            expect(result.code).toBe(response);
        }
    });

    test('accepts a script that opens with an assignment or a call, not a definition', () => {
        const python = lines('a, b = map(int, input().split())', 'print(a + b)');
        expect(extractCode(python, { language: 'python' })).toMatchObject({ status: 'ok', source: 'raw', code: python });

        const node = lines(
            "const [a, b] = require('fs').readFileSync(0, 'utf8').trim().split(/\\s+/).map(Number);",
            'console.log(a + b);'
        );
        expect(extractCode(node, { language: 'javascript' })).toMatchObject({ status: 'ok', source: 'raw', code: node });

        const call = lines('main()', '');
        expect(extractCode(call, { language: 'python' })).toMatchObject({ status: 'ok', code: 'main()' });
    });

    test('skips a prose preamble and says it had to', () => {
        const response = lines(
            'Sure! Here is a simple solution.',
            '',
            'def is_prime(n):',
            '    return n > 1'
        );
        const result = extractCode(response, { language: 'python', entry: 'is_prime' });
        expect(result.source).toBe('raw_after_prose');
        expect(result.code).toBe(lines('def is_prime(n):', '    return n > 1'));
    });

    test('drops the explanation a model adds after raw code', () => {
        const response = lines(
            'def reverse_string(s):',
            '    return s[::-1]',
            '',
            'This uses slicing with a negative step.',
            'It runs in linear time.'
        );
        const result = extractCode(response, { language: 'python', entry: 'reverse_string' });
        expect(result.code).toBe(lines('def reverse_string(s):', '    return s[::-1]'));
    });

    test('keeps helper blocks that precede the block defining the entry point', () => {
        const response = lines(
            'First a helper:',
            FENCE + 'python',
            'def _divisors(n):',
            '    return [i for i in range(2, n)]',
            FENCE,
            'Then the answer:',
            FENCE + 'python',
            'def is_prime(n):',
            '    return n > 1 and not _divisors(n)',
            FENCE
        );
        const result = extractCode(response, { language: 'python', entry: 'is_prime' });
        expect(result.blocks).toBe(2);
        expect(result.code).toContain('def _divisors(n):');
        expect(result.code).toContain('def is_prime(n):');
    });

    test('keeps a later redefinition, which is the one the interpreter would use', () => {
        const response = lines(
            'A naive version:',
            FENCE + 'python',
            'def is_prime(n):',
            '    return all(n % i for i in range(2, n))',
            FENCE,
            'Optimised:',
            FENCE + 'python',
            'def is_prime(n):',
            '    return n > 1',
            FENCE,
            'Benchmarks:',
            FENCE + 'text',
            'naive 2.1s, optimised 0.3s',
            FENCE
        );
        const result = extractCode(response, { language: 'python', entry: 'is_prime' });
        expect(result.blocks).toBe(2);
        expect(result.code.indexOf('return n > 1')).toBeGreaterThan(result.code.indexOf('range(2, n)'));
        expect(result.code).not.toContain('naive 2.1s');
    });

    test('ignores blocks that carry output rather than a program', () => {
        const response = lines(
            FENCE + 'text',
            'True',
            'False',
            FENCE,
            FENCE + 'python',
            'def is_prime(n):',
            '    return n > 1',
            FENCE
        );
        const result = extractCode(response, { language: 'python', entry: 'is_prime' });
        expect(result.code).toBe(lines('def is_prime(n):', '    return n > 1'));
    });

    test('takes an untagged fence, and honours one the response never closes', () => {
        const untagged = lines(FENCE, 'def is_prime(n):', '    return n > 1', FENCE);
        expect(extractCode(untagged, { language: 'python', entry: 'is_prime' }).code)
            .toBe(lines('def is_prime(n):', '    return n > 1'));

        const cutOff = lines('Here:', FENCE + 'python', 'def is_prime(n):', '    return n > 1');
        const result = extractCode(cutOff, { language: 'python', entry: 'is_prime' });
        expect(result.status).toBe('ok');
        expect(result.code).toBe(lines('def is_prime(n):', '    return n > 1'));
    });

    test('reads javascript responses, fenced and raw', () => {
        const fenced = lines(FENCE + 'js', 'function isPrime(n) {', '  return n > 1;', '}', FENCE);
        const fencedResult = extractCode(fenced, { language: 'javascript', entry: 'isPrime' });
        expect(fencedResult.code).toBe(lines('function isPrime(n) {', '  return n > 1;', '}'));

        const raw = lines('const isPrime = (n) => n > 1;');
        expect(extractCode(raw, { language: 'javascript', entry: 'isPrime' }).status).toBe('ok');

        const withProse = lines(
            'You can use:',
            'function isPrime(n) {',
            '  return n > 1;',
            '}',
            'That is all.'
        );
        expect(extractCode(withProse, { language: 'javascript', entry: 'isPrime' }).code)
            .toBe(lines('function isPrime(n) {', '  return n > 1;', '}'));
    });

    test('reports no_code rather than sending prose to a sandbox', () => {
        const cases = [
            '',
            '   ',
            null,
            undefined,
            'I cannot help with that request.',
            lines('The answer is that prime numbers have exactly two divisors.', 'Hope this helps!')
        ];
        for (const text of cases) {
            const result = extractCode(text, { language: 'python', entry: 'is_prime' });
            expect(result.status).toBe('no_code');
            expect(result.code).toBe('');
        }
    });

    test('reports no_code for a language it cannot read', () => {
        expect(extractCode('fn main() {}', { language: 'rust', entry: 'main' }).status).toBe('no_code');
    });

    test('omits a CommonJS usage example that redeclares the module exports', () => {
        const solution = 'const increment = n => n + 1;\nmodule.exports = { increment };';
        const response = lines(FENCE + 'js', solution, FENCE, '**Usage:**', FENCE + 'js',
            "const { increment } = require('./counter');", 'console.log(increment(2));', FENCE);
        expect(extractCode(response, { language: 'javascript' }))
            .toMatchObject({ status: 'ok', code: solution, blocks: 1 });
    });

    test.each([
        'Example production wiring:',
        'Callers (or tests) inject real or mock implementations:',
        'A thin adapter can wrap the HTTP client:',
        'In tests you simply pass stubs:',
        'You can now write tests like:'
    ])('keeps wiring and test examples outside the submitted module: %s', context => {
        const solution = 'class Service {}\nmodule.exports = { Service };';
        const response = lines(FENCE + 'js', solution, FENCE, context, FENCE + 'js',
            "const client = require('illustrated-client');", 'new Service({ client });', FENCE);
        expect(extractCode(response, { language: 'javascript' }).code).toBe(solution);
    });

    test('preserves helpers before and after an export, and subsequent export assignments', () => {
        const fragments = [
            'const offset = 1;',
            'exports.increment = n => helper(n);',
            'function helper(n) { return n + offset; }',
            'module.exports.decrement = n => n - offset;'
        ];
        const response = fragments.map((code, index) => lines(
            index === 2 ? 'Required helper for the example module:' : '', FENCE + 'js', code, FENCE)).join('\n\n');
        expect(extractCode(response, { language: 'javascript' }))
            .toMatchObject({ code: fragments.join('\n\n'), blocks: 4 });
    });

    test('does not remove an unlabelled fragment or a later exported solution', () => {
        const first = 'module.exports = { increment: n => n + 1 };';
        const second = 'module.exports = { increment: n => n + 2 };';
        const unlabelled = "require('missing-module');";
        const response = lines(FENCE + 'js', first, FENCE, 'An alternative example implementation:',
            FENCE + 'js', second, FENCE, FENCE + 'js', unlabelled, FENCE);
        expect(extractCode(response, { language: 'javascript' }).code)
            .toBe(lines(first, '', second, '', unlabelled));
    });

    test('does not infer an export from a comment or a string', () => {
        for (const code of ['// module.exports = {}', "const message = 'module.exports = {}';",
            '/*\nmodule.exports = {};\n*/', 'const message = `\nmodule.exports = {};\n`;']) {
            const response = lines(FENCE + 'js', code, FENCE, 'Usage:', FENCE + 'js', 'console.log(1);', FENCE);
            expect(extractCode(response, { language: 'javascript' }).blocks).toBe(2);
        }
    });

    test('works without an entry point or a CommonJS module, concatenating code blocks', () => {
        const response = lines(
            FENCE + 'python',
            'import math',
            FENCE,
            FENCE + 'python',
            'print(math.pi)',
            FENCE
        );
        const result = extractCode(response, { language: 'python' });
        expect(result.blocks).toBe(2);
        expect(result.code).toBe(lines('import math', '', 'print(math.pi)'));
        const script = lines(FENCE + 'js', 'const n = 2;', FENCE, 'Usage:', FENCE + 'js', 'console.log(n);', FENCE);
        expect(extractCode(script, { language: 'javascript' }).code).toBe('const n = 2;\n\nconsole.log(n);');
    });
});

describe('recognising a definition of the entry point', () => {
    test('finds python definitions in their usual forms', () => {
        expect(definesEntry('def is_prime(n):', 'python', 'is_prime')).toBe(true);
        expect(definesEntry('async def is_prime(n):', 'python', 'is_prime')).toBe(true);
        expect(definesEntry('class is_prime:', 'python', 'is_prime')).toBe(true);
        expect(definesEntry('is_prime = lambda n: n > 1', 'python', 'is_prime')).toBe(true);
        expect(definesEntry('def is_primary(n):', 'python', 'is_prime')).toBe(false);
        expect(definesEntry('result = is_prime(7)', 'python', 'is_prime')).toBe(false);
    });

    test('finds javascript definitions in their usual forms', () => {
        expect(definesEntry('function isPrime(n) {}', 'javascript', 'isPrime')).toBe(true);
        expect(definesEntry('export async function isPrime(n) {}', 'javascript', 'isPrime')).toBe(true);
        expect(definesEntry('const isPrime = (n) => n > 1;', 'javascript', 'isPrime')).toBe(true);
        expect(definesEntry('class isPrime extends Base {}', 'javascript', 'isPrime')).toBe(true);
        expect(definesEntry('isPrime(7);', 'javascript', 'isPrime')).toBe(false);
    });

    test('treats a missing entry name as no definition', () => {
        expect(definesEntry('def is_prime(n):', 'python', null)).toBe(false);
    });
});

describe('deciding where unfenced code begins', () => {
    test('accepts definitions, imports, assignments and calls at column zero, not prose', () => {
        expect(startsProgram('def f():', 'python')).toBe(true);
        expect(startsProgram('import math', 'python')).toBe(true);
        expect(startsProgram('@decorator', 'python')).toBe(true);
        expect(startsProgram('# a comment', 'python')).toBe(true);
        expect(startsProgram('x = 1', 'python')).toBe(true);
        expect(startsProgram('a, b = 1, 2', 'python')).toBe(true);
        expect(startsProgram('main()', 'python')).toBe(true);
        expect(startsProgram("const [a, b] = require('fs');", 'javascript')).toBe(true);
        expect(startsProgram('let { x } = point;', 'javascript')).toBe(true);
        expect(startsProgram('    def f():', 'python')).toBe(false);
        expect(startsProgram('Here is the function you asked for:', 'python')).toBe(false);
        expect(startsProgram('The function returns True when n = 2.', 'python')).toBe(false);
        expect(startsProgram('Note, the value = 2.', 'python')).toBe(false);
    });
});
