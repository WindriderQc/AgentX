'use strict';

const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const execute = promisify(execFile);
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const native = path.resolve(__dirname, '../../../integrations/secretary');

// Real native archive reader, synthetic bytes and temporary files only. A
// provider, model, OCR, import and mailbox executor are never configured.
async function archive({ body = 'A synthetic source 🦉 '.repeat(800), attachment = true } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'history-source-review-'));
  const threadId = '1234567890abcdea', messageId = '1234567890abcdef';
  const raw = Buffer.from('Message-ID: <synthetic@example.invalid>\r\nFrom: Synthetic <source@example.invalid>\r\n'
    + 'Subject: Synthetic source\r\nMIME-Version: 1.0\r\nContent-Type: multipart/mixed; boundary=outer\r\n\r\n'
    + '--outer\r\nContent-Type: multipart/alternative; boundary=inner\r\n\r\n'
    + '--inner\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Transfer-Encoding: base64\r\n\r\n'
    + Buffer.from(body).toString('base64') + '\r\n--inner\r\nContent-Type: text/html; charset=utf-8\r\n\r\n'
    + '<p>Other text &lt;img src=x onerror=alert(1)&gt;</p><a href="https://external.invalid/document">Linked document</a>'
    + '\r\n--inner--\r\n'
    + (attachment ? '--outer\r\nContent-Type: application/octet-stream\r\nContent-Disposition: attachment; filename=synthetic.bin\r\n\r\nBinary fixture\r\n' : '')
    + '--outer--\r\n');
  const sourceSha256 = sha(raw), relative = `raw/${sourceSha256}.eml`;
  for (const directory of ['raw', 'raw-receipts', `threads/${threadId}`]) await fs.mkdir(path.join(root, directory), { recursive: true });
  await fs.writeFile(path.join(root, relative), raw);
  await fs.writeFile(path.join(root, `raw-receipts/${messageId}.json`), JSON.stringify({
    messageId, threadId, path: relative, sha256: sourceSha256, bytes: raw.length
  }));
  await fs.writeFile(path.join(root, `threads/${threadId}/manifest.json`), JSON.stringify({ threadId,
    messages: [{ id: messageId, attachments: [] }] }));
  let calls = 0;
  const mail = { archived: async args => {
    calls++;
    const script = 'import sys,json\nsys.path.insert(0,sys.argv[1])\nfrom archive_read import read_original\n'
      + 'a=json.loads(sys.argv[3])\nprint(json.dumps(read_original(sys.argv[2],a["messageId"],a["sha256"],'
      + 'a.get("offset",0),part_index=a.get("part"))))';
    try {
      const result = await execute('python3', ['-c', script, native, root, JSON.stringify(args)], { maxBuffer: 1024 * 1024 });
      return JSON.parse(result.stdout);
    } catch {
      throw Object.assign(new Error('Synthetic native archive unavailable or revision changed'), { code: 'SECRETARY_ARCHIVE_UNAVAILABLE' });
    }
  } };
  return { root, mail, raw, relative, get calls() { return calls; },
    source: { system: 'gmail', messageId, threadId, sourceSha256, findingId: 'a'.repeat(64), direction: 'received' },
    damage: () => fs.writeFile(path.join(root, relative), Buffer.alloc(raw.length, 88)),
    cleanup: () => fs.rm(root, { recursive: true, force: true }) };
}

module.exports = { archive };
