'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { createHash, webcrypto } = require('node:crypto');
const { PNG } = require('pngjs');
const jpeg = require('jpeg-js');
const projects = require('../../public/js/image-text-project');

function source(bytes, mime = 'png', width = 100, height = 60) {
  return {
    operationId: 'image-operation-fixture',
    sha256: createHash('sha256').update(bytes).digest('hex'),
    width, height,
    dataUrl: `data:image/${mime};base64,${bytes.toString('base64')}`
  };
}

function pngBytes(width = 100, height = 60) {
  return PNG.sync.write({ width, height, data: Buffer.alloc(width * height * 4, 255) });
}

const png = pngBytes();

function project(text = 'École — façade\nCréations 💡') {
  const result = projects.create(source(png));
  result.labels.push({
    id: 'label-fixture', text, x: 0.25, y: 0.5, fontSize: 10,
    color: '#123ABC', background: '#fff', align: 'left'
  });
  return result;
}

function context(width = 100, height = 60) {
  return {
    canvas: { width, height },
    save: jest.fn(), restore: jest.fn(), setTransform: jest.fn(),
    clearRect: jest.fn(), drawImage: jest.fn(), fillRect: jest.fn(), fillText: jest.fn(),
    measureText: jest.fn(text => ({ width: Array.from(text).length * 6.5 })),
    filter: 'blur(4px)', globalAlpha: 0.5, globalCompositeOperation: 'multiply'
  };
}

describe('Image text project integrity and reopening', () => {
  test('reopens an independent project retaining exact Unicode and the source receipt', async () => {
    const original = project('École & café\nDe\u0301couverte 💡  <exact>');
    const before = JSON.stringify(original);
    const reopened = projects.parse(projects.stringify(original));
    expect(reopened).toEqual(original);
    expect(reopened).not.toBe(original);
    expect(reopened.source).not.toBe(original.source);
    expect(reopened.labels[0]).not.toBe(original.labels[0]);
    expect(await projects.verifySource(reopened, { crypto: webcrypto })).toEqual({
      mime: 'image/png', width: 100, height: 60, sha256: original.source.sha256
    });
    reopened.labels[0].text = 'Edited';
    expect(JSON.stringify(original)).toBe(before);
    expect(original.source.dataUrl).toBe(source(png).dataUrl);
  });

  test('creates a detached empty project without modifying its source', () => {
    const input = source(png);
    const result = projects.create(input);
    expect(result.schema).toBe('agentx.image-text-project/v1');
    expect(result.labels).toEqual([]);
    expect(result.source).toEqual(input);
    expect(result.source).not.toBe(input);
    result.source.width = 1;
    expect(input.width).toBe(100);
  });

  test('supports the browser global without importing dependencies', () => {
    const js = fs.readFileSync(path.resolve(__dirname, '../../public/js/image-text-project.js'), 'utf8');
    const browser = { window: {} };
    vm.runInNewContext(js, browser);
    expect(browser.window.ImageTextProject.SCHEMA).toBe(projects.SCHEMA);
    expect(typeof browser.window.ImageTextProject.svg).toBe('function');
  });

  test('verifies JPEG source dimensions and digest before decoding', async () => {
    const bytes = jpeg.encode({ width: 4, height: 3, data: Buffer.alloc(4 * 3 * 4, 255) }, 80).data;
    const result = projects.create(source(bytes, 'jpeg', 4, 3));
    expect(await projects.verifySource(result, { crypto: null })).toEqual({
      mime: 'image/jpeg', width: 4, height: 3, sha256: result.source.sha256
    });
  });

  test('rejects a modified source even when dimensions still agree', async () => {
    const input = project();
    const changed = Buffer.from(png);
    changed[changed.length - 1] ^= 1;
    input.source.dataUrl = source(changed).dataUrl;
    await expect(projects.verifySource(input)).rejects.toThrow('SHA-256 does not match');
  });

  test('rejects declared dimensions differing from embedded dimensions before hashing', async () => {
    const input = project();
    input.source.width = 99;
    const digest = jest.fn();
    await expect(projects.verifySource(input, { crypto: { subtle: { digest } } })).rejects.toThrow('dimensions do not match');
    expect(digest).not.toHaveBeenCalled();
  });

  test.each([[8193, 1, 'width'], [6000, 4000, 'pixel limit']])(
    'rejects dangerous PNG header dimensions %i×%i before hashing', async (width, height, message) => {
      const bytes = Buffer.from(png);
      bytes.writeUInt32BE(width, 16);
      bytes.writeUInt32BE(height, 20);
      const input = projects.create(source(bytes));
      const digest = jest.fn();
      await expect(projects.verifySource(input, { crypto: { subtle: { digest } } })).rejects.toThrow(message);
      expect(digest).not.toHaveBeenCalled();
    }
  );

  test.each([
    [Buffer.from('<svg><script>alert(1)</script></svg>'), 'png', 'PNG header'],
    [png, 'jpeg', 'JPEG header'],
    [Buffer.from([255, 216, 255, 224, 0, 20, 1]), 'jpeg', 'truncated JPEG segment'],
    [Buffer.from([255, 216, 255, 217]), 'jpeg', 'JPEG dimensions']
  ])('rejects unsupported or truncated embedded content', async (bytes, mime, message) => {
    await expect(projects.verifySource(projects.create(source(bytes, mime)))).rejects.toThrow(message);
  });

  test.each([0, 1, 55, 56, 63, 64, 65, 1000])('hash fallback matches SHA-256 for %i bytes', async length => {
    const bytes = Buffer.alloc(length);
    for (let index = 0; index < bytes.length; index += 1) bytes[index] = index % 256;
    expect(await projects.hashBytes(new Uint8Array(bytes), { crypto: null }))
      .toBe(createHash('sha256').update(bytes).digest('hex'));
  });

  test('native and fallback hashes agree for the embedded image', async () => {
    const bytes = new Uint8Array(png);
    expect(await projects.hashBytes(bytes, { crypto: webcrypto })).toBe(await projects.hashBytes(bytes, { crypto: null }));
  });
});

describe('Safe exact-text serialization and bounds', () => {
  test('escapes malicious text in SVG while keeping text unchanged in the project', () => {
    const text = '"<script>alert(1)</script>" & \'é\'';
    const input = project(text);
    const svg = projects.svg(input);
    expect(svg).toContain('&quot;&lt;script&gt;alert(1)&lt;/script&gt;&quot; &amp; &apos;é&apos;');
    expect(svg).not.toContain('<script>');
    expect(svg).not.toContain('onload=');
    expect(svg).not.toMatch(/>\s+</);
    expect(svg).toContain(`href="${input.source.dataUrl}"`);
    expect(projects.parse(projects.stringify(input)).labels[0].text).toBe(text);
  });

  test.each(['https://example.test/image.png', 'javascript:alert(1)', 'data:image/svg+xml;base64,PHN2Zy8+',
    'data:image/png;base64,A===', 'data:image/png;base64,A', 'data:image/png;base64,AB==',
    'data:image/png;base64,AAA=\n', 'data:image/png;charset=utf-8;base64,AAAA'])('rejects unsafe data URL %s', dataUrl => {
    const input = project();
    input.source.dataUrl = dataUrl;
    expect(() => projects.validate(input)).toThrow();
  });

  test.each([
    ['schema', input => { input.schema = 'unknown/v2'; }],
    ['unknown field', input => { input.script = 'malicious'; }],
    ['unknown source field', input => { input.source.href = 'https://example.test'; }],
    ['unknown label field', input => { input.labels[0].style = 'url(example.test)'; }],
    ['duplicate label IDs', input => { input.labels.push({ ...input.labels[0] }); }],
    ['nonfinite x', input => { input.labels[0].x = Infinity; }],
    ['NaN y', input => { input.labels[0].y = NaN; }],
    ['negative x', input => { input.labels[0].x = -0.1; }],
    ['y > 1', input => { input.labels[0].y = 1.1; }],
    ['font size zero', input => { input.labels[0].fontSize = 0; }],
    ['font size too large', input => { input.labels[0].fontSize = projects.MAX_FONT_SIZE + 1; }],
    ['CSS color', input => { input.labels[0].color = 'url(https://example.test)'; }],
    ['CSS background', input => { input.labels[0].background = 'red'; }],
    ['empty background', input => { input.labels[0].background = ''; }],
    ['alignment', input => { input.labels[0].align = 'start'; }],
    ['operation ID injection', input => { input.source.operationId = '\"><script>'; }],
    ['fractional dimensions', input => { input.source.width = 10.5; }],
    ['zero dimensions', input => { input.source.height = 0; }],
    ['oversized edge', input => { input.source.width = projects.MAX_EDGE + 1; }],
    ['oversized pixels', input => { input.source.width = 6000; input.source.height = 4000; }],
    ['bad digest', input => { input.source.sha256 = 'unknown'; }],
    ['oversized text', input => { input.labels[0].text = 'é'.repeat(301); }],
    ['oversized Unicode text', input => { input.labels[0].text = '💡'.repeat(301); }],
    ['NUL text', input => { input.labels[0].text = 'a\u0000b'; }],
    ['lone surrogate', input => { input.labels[0].text = '\uD800'; }]
  ])('rejects %s', (_name, mutate) => {
    const input = project();
    mutate(input);
    expect(() => projects.validate(input)).toThrow();
  });

  test('accepts exactly 300 Unicode codepoints and a transparent background', () => {
    const input = project('💡'.repeat(300));
    input.labels[0].background = null;
    expect(projects.validate(input).labels[0].text).toBe(input.labels[0].text);
    expect(projects.svg(input)).not.toContain('<rect');
  });

  test('bounds labels, JSON and encoded source sizes', () => {
    const input = project();
    input.labels = Array.from({ length: projects.MAX_LABELS + 1 }, (_value, id) => ({ ...input.labels[0], id: `label-${id}` }));
    expect(() => projects.validate(input)).toThrow('label limit');
    expect(() => projects.parse(' '.repeat(projects.MAX_JSON_BYTES + 1))).toThrow('size limit');
    const oversized = project();
    oversized.source.dataUrl = `data:image/png;base64,${'A'.repeat(projects.MAX_BASE64_BYTES + 4)}`;
    expect(() => projects.validate(oversized)).toThrow('base64 data');
  });

  test('rejects invalid JSON, omitted fields, unsupported schema and prototype keys', () => {
    expect(() => projects.parse('{')).toThrow('JSON is invalid');
    expect(() => projects.parse('null')).toThrow();
    expect(() => projects.parse('{"schema":"unknown"}')).toThrow();
    const json = projects.stringify(project());
    expect(() => projects.parse(json.replace('"labels": [', '"__proto__": {}, "labels": ['))).toThrow('unsupported field');
    const missing = project();
    delete missing.labels[0].align;
    expect(() => projects.validate(missing)).toThrow('align is required');
  });
});

describe('Canvas and SVG exact-text placement', () => {
  test('uses native image coordinates, multiline spacing and matching background geometry', () => {
    const input = project('First\nÉté');
    input.labels[0].align = 'center';
    const before = JSON.stringify(input);
    const ctx = context();
    const image = { naturalWidth: 100, naturalHeight: 60 };
    projects.draw(ctx, input, image);
    expect(ctx.drawImage).toHaveBeenCalledWith(image, 0, 0, 100, 60);
    expect(ctx.fillText.mock.calls).toEqual([['First', 25, 39], ['Été', 25, 51.5]]);
    expect(ctx.fillRect).toHaveBeenCalledWith(6.75, 28, 36.5, 26.5);
    expect(ctx.font).toBe('10px Arial, Helvetica, sans-serif');
    expect(ctx.textAlign).toBe('center');
    expect(ctx.textBaseline).toBe('alphabetic');
    expect(ctx.fontKerning).toBe('normal');
    expect(ctx.globalAlpha).toBe(1);
    expect(ctx.globalCompositeOperation).toBe('source-over');
    expect(ctx.filter).toBe('none');
    expect(ctx.setTransform).toHaveBeenCalledWith(1, 0, 0, 1, 0, 0);
    expect(ctx.save).toHaveBeenCalledTimes(1);
    expect(ctx.restore).toHaveBeenCalledTimes(1);
    const svg = projects.svg(input);
    expect(svg).toContain('text-anchor="middle"');
    expect(svg).toContain('font-kerning="normal"');
    expect(svg).toContain('<tspan x="25" y="39">First</tspan>');
    expect(svg).toContain('<tspan x="25" y="51.5">Été</tspan>');
    expect(svg).toContain('<rect x="6.75" y="28" width="36.5" height="26.5"');
    expect(JSON.stringify(input)).toBe(before);
  });


  test('uses measured font ascent for a shared alphabetic baseline', () => {
    const ctx = context();
    ctx.measureText.mockImplementation(text => ({ width: text.length * 6.5, fontBoundingBoxAscent: 11 }));
    projects.draw(ctx, project('Été'), { width: 100, height: 60 });
    expect(ctx.fillText).toHaveBeenCalledWith('Été', 25, 41);
    expect(ctx.measureText).toHaveBeenCalledWith('Mg');
    const js = fs.readFileSync(path.resolve(__dirname, '../../public/js/image-text-project.js'), 'utf8');
    const browser = { window: { document: { createElement: () => ({ getContext: () => ctx }) } } };
    vm.runInNewContext(js, browser);
    expect(browser.window.ImageTextProject.svg(project('Été'))).toContain('<tspan x="25" y="41">Été</tspan>');
  });

  test('preserves blank lines and CRLF line breaks when rendering', () => {
    const input = project('a\r\n\r\nb');
    const ctx = context();
    projects.draw(ctx, input, { width: 100, height: 60 });
    expect(ctx.fillText.mock.calls).toEqual([['a', 25, 39], ['', 25, 51.5], ['b', 25, 64]]);
    expect(projects.parse(projects.stringify(input)).labels[0].text).toBe('a\r\n\r\nb');
  });

  test('restores drawing state if a canvas operation fails', () => {
    const ctx = context();
    ctx.fillText.mockImplementation(() => { throw new Error('Canvas failed'); });
    expect(() => projects.draw(ctx, project(), { width: 100, height: 60 })).toThrow('Canvas failed');
    expect(ctx.restore).toHaveBeenCalledTimes(1);
  });

  test('rejects a mismatching decoded image or export canvas', () => {
    expect(() => projects.draw(context(), project(), { width: 99, height: 60 })).toThrow('Decoded image dimensions');
    expect(() => projects.draw(context(50, 30), project(), { width: 100, height: 60 })).toThrow('Canvas dimensions');
  });
});
