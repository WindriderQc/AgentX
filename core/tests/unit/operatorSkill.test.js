const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const express = require('express');
const request = require('supertest');
const { buildOperatorSkill, archive, splitSheet } = require('../../src/services/operatorSkill');
const { createOperatorSkillRouter } = require('../../routes/operator-skill');

// Reads a zip back through its central directory, as an installer would.
function unzip(buffer) {
  const end = buffer.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  const count = buffer.readUInt16LE(end + 10);
  let at = buffer.readUInt32LE(end + 16);
  const files = {};
  for (let index = 0; index < count; index += 1) {
    expect(buffer.readUInt32LE(at)).toBe(0x02014b50);
    const size = buffer.readUInt32LE(at + 20);
    const nameLength = buffer.readUInt16LE(at + 28);
    const offset = buffer.readUInt32LE(at + 42);
    const name = buffer.toString('utf8', at + 46, at + 46 + nameLength);
    const dataStart = offset + 30 + buffer.readUInt16LE(offset + 26) + buffer.readUInt16LE(offset + 28);
    const text = zlib.inflateRawSync(buffer.subarray(dataStart, dataStart + size));
    expect(zlib.crc32(text)).toBe(buffer.readUInt32LE(at + 16));
    files[name] = text.toString('utf8');
    at += 46 + nameLength;
  }
  return files;
}

describe('operator skill', () => {
  let root;
  beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'operator-skill-')); });
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  const sheet = (text) => {
    fs.mkdirSync(path.join(root, 'config/operator-skill'), { recursive: true });
    fs.writeFileSync(path.join(root, 'config/operator-skill/instance.md'), text);
  };
  const build = (extra = {}) => buildOperatorSkill({
    instanceRoot: root, revision: 'abc1234def', now: new Date('2026-10-08T12:00:00Z'), origin: 'https://core.test', ...extra,
  });

  test('the product skill names no home and stands alone without a sheet', async () => {
    const skill = await build();
    const names = skill.files.map((file) => file.name);
    expect(names).toEqual(expect.arrayContaining(['SKILL.md', 'references/endpoints.md', 'references/served.md']));
    expect(names).not.toContain('references/instance.md');
    expect(skill.instanceSheet).toBe(false);
    const product = skill.files.filter((file) => file.name !== 'references/served.md').map((file) => file.text).join('\n');
    expect(product).not.toMatch(/\b(?:10|192\.168|172\.(?:1[6-9]|2\d|3[01]))\.\d+\.\d+/);
    expect(skill.files.find((file) => file.name === 'references/served.md').text).toContain('abc1234def');
  });

  test('a mounted sheet is added and its description replaces the product one', async () => {
    sheet('---\ndescription: "Operate the Maple house instance; use for Maple or Juniper."\n---\n# Maple house\n\nCore: https://maple.test\n');
    const skill = await build();
    const text = (name) => skill.files.find((file) => file.name === name).text;
    expect(skill.instanceSheet).toBe(true);
    expect(text('references/instance.md')).toBe('# Maple house\n\nCore: https://maple.test\n');
    expect(text('SKILL.md')).toMatch(/^---\nname: agentx\ndescription: "Operate the Maple house instance; use for Maple or Juniper\."\n---/);
    expect(text('references/served.md')).toContain('included');
  });

  test('a sheet without front matter is taken whole', () => {
    expect(splitSheet('# Just a sheet\n')).toEqual({ description: null, body: '# Just a sheet\n' });
  });

  test('the archive unpacks to one folder with every file intact', async () => {
    sheet('# Maple house — accents: é à ü\n');
    const skill = await build();
    const files = unzip(archive(skill, new Date('2026-10-08T12:00:00Z')));
    expect(Object.keys(files).sort()).toEqual(skill.files.map((file) => `agentx/${file.name}`).sort());
    for (const file of skill.files) expect(files[`agentx/${file.name}`]).toBe(file.text);
  });

  test('routes describe the skill and send it as an attachment', async () => {
    const app = express();
    app.use('/api/operator-skill', createOperatorSkillRouter({ build: (options) => build(options), revision: () => 'abc1234def' }));
    const info = await request(app).get('/api/operator-skill').expect(200);
    expect(info.body.data).toMatchObject({ name: 'agentx', revision: 'abc1234def', download: '/api/operator-skill/download' });
    const download = await request(app).get('/api/operator-skill/download').buffer(true)
      .parse((res, done) => { const chunks = []; res.on('data', (c) => chunks.push(c)); res.on('end', () => done(null, Buffer.concat(chunks))); })
      .expect(200);
    expect(download.headers['content-type']).toBe('application/zip');
    expect(download.headers['content-disposition']).toBe('attachment; filename="agentx-skill-abc1234d.zip"');
    expect(Object.keys(unzip(download.body))).toContain('agentx/SKILL.md');
  });

  test('a build without the skill answers 404 instead of an empty archive', async () => {
    const app = express();
    app.use('/api/operator-skill', createOperatorSkillRouter({ build: () => buildOperatorSkill({ productDirs: [root] }) }));
    const response = await request(app).get('/api/operator-skill/download').expect(404);
    expect(response.body.error.code).toBe('OPERATOR_SKILL_UNAVAILABLE');
  });
});
