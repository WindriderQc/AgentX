'use strict';

const { commandLine } = require('../../runner/execute');

const JOB = { memory_mb: 256, timeout_ms: 5000, args: ['driver.js'] };

describe('code runner command line', () => {
    test('node jobs get no address-space cap, which V8 cannot start under, and a bounded heap', () => {
        const { file, argv } = commandLine(JOB, '/usr/local/bin/node', true);

        expect(file).toBe('prlimit');
        expect(argv.some(arg => arg.startsWith('--as='))).toBe(false);
        expect(argv).toEqual(expect.arrayContaining(['--nproc=128', '--nofile=64', '--cpu=6']));
        expect(argv.slice(-3)).toEqual(['/usr/local/bin/node', '--max-old-space-size=256', 'driver.js']);
    });

    test('python jobs keep the address-space cap', () => {
        const { argv } = commandLine({ ...JOB, args: ['driver.py'] }, '/usr/bin/python3', true);

        expect(argv[0]).toBe(`--as=${256 * 1024 * 1024}`);
        expect(argv.slice(-2)).toEqual(['/usr/bin/python3', 'driver.py']);
    });

    test('without prlimit the interpreter runs directly, node still with a bounded heap', () => {
        expect(commandLine(JOB, '/opt/node/bin/node', false))
            .toEqual({ file: '/opt/node/bin/node', argv: ['--max-old-space-size=256', 'driver.js'] });
        expect(commandLine({ ...JOB, args: ['driver.py'] }, 'python3', false))
            .toEqual({ file: 'python3', argv: ['driver.py'] });
    });
});
