'use strict';

// Retain upstream's browser authentication. Publish only the launch token to
// Core's private read-only instance mount, and redact it from service output.
const fs = require('node:fs');
const { spawn } = require('node:child_process');
const { StringDecoder } = require('node:string_decoder');

const file = process.env.DSH_STUDIO_LAUNCH_FILE;
const child = spawn(process.argv[2], process.argv.slice(3), { stdio: ['inherit', 'pipe', 'pipe'] });
let published;
let failed = false;
function publish(line) {
  if (published || !line.startsWith('dsh web: ')) return;
  const url = new URL(line.slice('dsh web: '.length).trim());
  const token = url.searchParams.get('token');
  if (!/^[A-Za-z0-9_-]{43}$/.test(token || '')) throw new Error('DSH did not provide its native launch token');
  const temporary = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify({ contract: 'agentx.dsh-studio-launch/v1', token }) + '\n', { mode: 0o600 });
  fs.renameSync(temporary, file);
  published = token;
}
function output(stream) {
  const decoder = new StringDecoder('utf8');
  let buffer = '';
  return chunk => {
    buffer += decoder.write(chunk);
    while (buffer.includes('\n')) {
      const at = buffer.indexOf('\n');
      const line = buffer.slice(0, at);
      buffer = buffer.slice(at + 1);
      try { publish(line); }
      catch { failed = true; child.kill('SIGTERM'); process.stderr.write('DSH native launch could not be published.\n'); }
      stream.write(line.replace(/([?&]token=)[A-Za-z0-9_-]+/g, '$1<redacted>') + '\n');
    }
    if (buffer.length > 65536) buffer = '';
  };
}
child.stdout.on('data', output(process.stdout));
child.stderr.on('data', output(process.stderr));
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal));
child.on('error', () => { failed = true; process.stderr.write('DSH process could not start.\n'); });
child.on('close', (code, signal) => {
  try {
    if (published && JSON.parse(fs.readFileSync(file, 'utf8')).token === published) fs.unlinkSync(file);
  } catch (error) { if (error.code !== 'ENOENT') failed = true; }
  process.exitCode = failed || signal ? 1 : code;
});
