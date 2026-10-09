'use strict';

/**
 * The operator skill a consumer downloads from this instance: the product's
 * generic skill, plus the instance's own sheet when one is mounted. The
 * product part never names a home; the sheet never ships with the product.
 */

const fs = require('fs/promises');
const path = require('path');
const zlib = require('zlib');

const SKILL_NAME = 'agentx';
const INSTANCE_SHEET = 'config/operator-skill/instance.md';
const MAX_FILE_BYTES = 256 * 1024;

// In the image the skill sits beside the other product files; in a checkout it
// is still at the repository root.
const PRODUCT_DIRS = [
  path.join(__dirname, '../../product-config/skills', SKILL_NAME),
  path.join(__dirname, '../../../skills', SKILL_NAME),
];

async function readBounded(file) {
  const stat = await fs.stat(file);
  if (stat.size > MAX_FILE_BYTES) throw new Error(`${path.basename(file)} exceeds ${MAX_FILE_BYTES} bytes`);
  return fs.readFile(file, 'utf8');
}

async function listFiles(root, relative = '') {
  const found = [];
  for (const entry of (await fs.readdir(path.join(root, relative), { withFileTypes: true }))
    .sort((a, b) => a.name.localeCompare(b.name))) {
    const next = path.posix.join(relative, entry.name);
    if (entry.isDirectory()) found.push(...await listFiles(root, next));
    else if (entry.isFile()) found.push(next);
  }
  return found;
}

async function productDir(candidates) {
  for (const dir of candidates) {
    try { await fs.access(path.join(dir, 'SKILL.md')); return dir; } catch { /* next */ }
  }
  return null;
}

// An instance sheet may open with `description: ...` between `---` lines. That
// sentence replaces the product's so the skill answers to the home's own names.
function splitSheet(text) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text);
  if (!match) return { description: null, body: text };
  const line = /^description:\s*(.+)$/m.exec(match[1]);
  const description = line ? line[1].trim().replace(/^"(.*)"$/, '$1') : null;
  return { description: description || null, body: text.slice(match[0].length) };
}

function withDescription(skill, description) {
  if (!description) return skill;
  return skill.replace(/^description:.*$/m, `description: ${JSON.stringify(description)}`);
}

async function buildOperatorSkill(options = {}) {
  const dir = await productDir(options.productDirs || PRODUCT_DIRS);
  if (!dir) return null;
  const instanceRoot = options.instanceRoot === undefined ? process.env.AGENTX_INSTANCE_ROOT : options.instanceRoot;
  const now = options.now || new Date();
  const revision = options.revision || 'unknown';

  let sheet = null;
  if (instanceRoot) {
    try { sheet = splitSheet(await readBounded(path.join(instanceRoot, INSTANCE_SHEET))); } catch { sheet = null; }
  }

  const files = [];
  for (const name of await listFiles(dir)) {
    if (['references/instance.md', 'references/served.md'].includes(name)) continue;
    const text = await readBounded(path.join(dir, name));
    files.push({ name, text: name === 'SKILL.md' ? withDescription(text, sheet?.description) : text });
  }
  if (sheet) files.push({ name: 'references/instance.md', text: sheet.body });
  files.push({
    name: 'references/served.md',
    text: [
      '# Where this copy came from', '',
      `- Product revision: \`${revision}\``,
      `- Generated: ${now.toISOString()}`,
      `- Served by: ${options.origin || 'unknown'}`,
      `- Instance sheet: ${sheet ? 'included (`references/instance.md`)' : 'none mounted'}`, '',
      'Download a fresh copy from the same instance when its revision changes.', '',
    ].join('\n'),
  });

  return {
    name: SKILL_NAME, revision, generatedAt: now.toISOString(), instanceSheet: Boolean(sheet),
    files: files.map((file) => ({ ...file, bytes: Buffer.byteLength(file.text) })),
  };
}

function dosTime(date) {
  const year = Math.max(1980, date.getFullYear());
  return {
    time: (date.getHours() << 11) | (date.getMinutes() << 5) | (date.getSeconds() >> 1),
    date: ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate(),
  };
}

// A small deflate-only zip writer: a handful of text files does not justify a
// dependency.
function zip(entries, date = new Date()) {
  const stamp = dosTime(date);
  const local = [];
  const central = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8');
    const raw = Buffer.from(entry.text, 'utf8');
    const data = zlib.deflateRawSync(raw);
    const crc = zlib.crc32(raw);
    const head = Buffer.alloc(30);
    head.writeUInt32LE(0x04034b50, 0); head.writeUInt16LE(20, 4); head.writeUInt16LE(0x0800, 6);
    head.writeUInt16LE(8, 8); head.writeUInt16LE(stamp.time, 10); head.writeUInt16LE(stamp.date, 12);
    head.writeUInt32LE(crc, 14); head.writeUInt32LE(data.length, 18); head.writeUInt32LE(raw.length, 22);
    head.writeUInt16LE(name.length, 26);
    local.push(head, name, data);
    const record = Buffer.alloc(46);
    record.writeUInt32LE(0x02014b50, 0); record.writeUInt16LE(20, 4); record.writeUInt16LE(20, 6);
    record.writeUInt16LE(0x0800, 8); record.writeUInt16LE(8, 10); record.writeUInt16LE(stamp.time, 12);
    record.writeUInt16LE(stamp.date, 14); record.writeUInt32LE(crc, 16); record.writeUInt32LE(data.length, 20);
    record.writeUInt32LE(raw.length, 24); record.writeUInt16LE(name.length, 28); record.writeUInt32LE(offset, 42);
    central.push(record, name);
    offset += head.length + name.length + data.length;
  }
  const directory = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, directory, end]);
}

function archive(skill, date = new Date()) {
  return zip(skill.files.map((file) => ({ name: `${skill.name}/${file.name}`, text: file.text })), date);
}

module.exports = { buildOperatorSkill, archive, zip, splitSheet, INSTANCE_SHEET };
