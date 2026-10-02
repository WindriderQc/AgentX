'use strict';

const crypto = require('node:crypto');
const { readFile } = require('node:fs/promises');
const path = require('node:path');
const { fingerprint } = require('./contract');

async function main() {
  const specs = process.argv.slice(2);
  if (specs.length < 1) throw new Error('usage: node pinset.js name=/absolute/file [name=/absolute/file ...]');
  const pins = [];
  for (const spec of specs) {
    const separator = spec.indexOf('=');
    const name = separator > 0 ? spec.slice(0, separator) : '';
    const filePath = separator > 0 ? spec.slice(separator + 1) : '';
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,119}$/.test(name) || !path.isAbsolute(filePath)) {
      throw new Error(`invalid pin specification: ${spec}`);
    }
    pins.push({
      name,
      path: path.resolve(filePath),
      sha256: crypto.createHash('sha256').update(await readFile(filePath)).digest('hex'),
    });
  }
  const normalized = [...pins].sort((left, right) => left.name.localeCompare(right.name));
  process.stdout.write(`${JSON.stringify({ pins, fingerprint: fingerprint(normalized) }, null, 2)}\n`);
}

main().catch((error) => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; });
