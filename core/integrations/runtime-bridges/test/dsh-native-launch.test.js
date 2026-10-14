'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const test = require('node:test');

test('native launch wrapper publishes privately, redacts output and removes only its own record', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-native-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  for (const successor of [false, true]) {
    const file = path.join(directory, 'launch.json');
    const token = 'n'.repeat(43);
    const script = `console.log('dsh web: http://127.0.0.1:3085/?token=${token}'); setInterval(()=>{},1000);`;
    const wrapper = path.resolve(__dirname, '../../../../integrations/coding/dsh-studio-launch.cjs');
    const child = spawn(process.execPath, [wrapper, process.execPath, '-e', script], {
      env: { ...process.env, DSH_STUDIO_LAUNCH_FILE: file }, stdio: ['ignore', 'pipe', 'pipe'],
    });
    t.after(() => child.kill('SIGTERM'));
    const closed = once(child, 'close');
    const [output] = await once(child.stdout, 'data');
    assert.equal(output.toString().includes(token), false);
    assert.match(output.toString(), /token=<redacted>/);
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { contract: 'agentx.dsh-studio-launch/v1', token });
    if (successor) fs.writeFileSync(file, JSON.stringify({ token: 'successor' }));
    child.kill('SIGTERM');
    await closed;
    assert.equal(fs.existsSync(file), successor);
  }
});
