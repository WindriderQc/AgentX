'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { jobEnvironment, removeJobDir } = require('../../runner/execute');

describe('code runner job cleanup', () => {
    afterEach(() => jest.restoreAllMocks());

    test('jobs never write Python bytecode caches', () => {
        expect(jobEnvironment('/work/job-1')).toMatchObject({
            HOME: '/work/job-1',
            PYTHONDONTWRITEBYTECODE: '1'
        });
    });

    // Ownership recovery needs POSIX uids; the runner only runs on Linux.
    const posixTest = typeof process.getuid === 'function' ? test : test.skip;

    posixTest('takes the tree back with chown and retries when removal is denied', () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'runner-cleanup-'));
        fs.mkdirSync(path.join(dir, '__pycache__'));
        const realRm = fs.rmSync;
        const denied = Object.assign(new Error('permission denied'), { code: 'EACCES' });
        const rm = jest.spyOn(fs, 'rmSync')
            .mockImplementationOnce(() => { throw denied; })
            .mockImplementation((...args) => realRm(...args));
        const chownTree = jest.fn();

        removeJobDir(dir, { chownTree });

        expect(chownTree).toHaveBeenCalledWith(dir, expect.any(Number), expect.any(Number));
        expect(rm).toHaveBeenCalledTimes(2);
        expect(fs.existsSync(dir)).toBe(false);
    });

    test('rethrows errors that are not about permissions', () => {
        const busy = Object.assign(new Error('busy'), { code: 'EBUSY' });
        jest.spyOn(fs, 'rmSync').mockImplementation(() => { throw busy; });
        const chownTree = jest.fn();

        expect(() => removeJobDir('/work/job-2', { chownTree })).toThrow('busy');
        expect(chownTree).not.toHaveBeenCalled();
    });
});
