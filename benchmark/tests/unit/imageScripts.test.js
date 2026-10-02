'use strict';

const fs = require('fs');
const path = require('path');

// The benchmark image deletes every script except an allowlist. A migration
// is run inside the deployed container, so its file must survive that filter.
describe('benchmark image scripts', () => {
    const dockerfile = fs.readFileSync(path.resolve(__dirname, '..', '..', '..', 'docker', 'benchmark.Dockerfile'), 'utf8');
    const kept = [...dockerfile.matchAll(/! -name '([^']+)'/g)]
        .map(([, glob]) => new RegExp(`^${glob.replace(/[.]/g, '\\.').replace(/\*/g, '.*')}$`));
    const { scripts } = require('../../package.json');

    test.each(Object.entries(scripts).filter(([name]) => name.startsWith('migrate:')))(
        '%s ships its script in the image',
        (name, command) => {
            const file = path.basename(command.match(/scripts\/(\S+\.js)/)[1]);
            expect(kept.some(pattern => pattern.test(file))).toBe(true);
            expect(fs.existsSync(path.resolve(__dirname, '..', '..', 'scripts', file))).toBe(true);
        }
    );
});
