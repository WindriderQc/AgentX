'use strict';

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

describe('Models stats strip', () => {
  const source = fs.readFileSync(path.resolve(__dirname, '../../public/js/models-stats-strip.js'), 'utf8');
  const context = vm.createContext({ URL });
  vm.runInContext(source, context);

  const install = (url, hostName, digest, size) => ({
    provider: 'ollama', size, source: { url, hostName, metadata: { digest } },
  });

  test('counts a blob shared by two endpoints of one machine once', () => {
    const usage = context.stripDiskUsage([
      install('http://10.0.0.5:11434', 'Alien', 'sha-a', 100),
      install('http://10.0.0.5:11435', 'Alien CPU', 'sha-a', 100),
      install('http://10.0.0.5:11435', 'Alien CPU', 'sha-b', 30),
      install('http://10.0.0.6:11434', 'Frank', 'sha-a', 100),
    ]);
    expect(usage.raw).toBe(330);
    expect(usage.disk).toBe(230);
    expect(usage.machines.map(m => [m.machine, m.bytes, m.label])).toEqual([
      ['10.0.0.5', 130, 'Alien'],
      ['10.0.0.6', 100, 'Frank'],
    ]);
  });

  test('counts installs without a digest as-is', () => {
    const usage = context.stripDiskUsage([
      install('http://10.0.0.5:11434', 'Alien', undefined, 40),
      install('http://10.0.0.5:11435', 'Alien CPU', undefined, 40),
    ]);
    expect(usage.disk).toBe(80);
  });

  test('keeps the readiness ids as plain leading numbers', () => {
    const view = fs.readFileSync(path.resolve(__dirname, '../../views/pages/models.ejs'), 'utf8');
    for (const id of ['statTotal', 'statStorage', 'statHosts']) {
      expect(view).toMatch(new RegExp(`id="${id}">--<`));
    }
    expect(source).toMatch(/stripSetText\('statTotal', String\(activeLogical\.length\)\)/);
  });
});
