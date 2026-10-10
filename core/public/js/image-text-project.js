(function (root, factory) {
  var api = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.ImageTextProject = api;
})(typeof window !== 'undefined' ? window : globalThis, function (root) {
  'use strict';

  var SCHEMA = 'agentx.image-text-project/v1';
  var MAX_BASE64_BYTES = 64 * 1024 * 1024;
  var MAX_JSON_BYTES = 65 * 1024 * 1024;
  var MAX_LABELS = 100;
  var MAX_TEXT_LENGTH = 300;
  var MAX_EDGE = 8192;
  var MAX_PIXELS = 16000000;
  var MIN_FONT_SIZE = 1;
  var MAX_FONT_SIZE = 1024;
  var FONT_FAMILY = 'Arial, Helvetica, sans-serif';
  var BASE64_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  var cachedMeasurementContext;

  function fail(message) { throw new Error(message); }

  function record(value, name, keys) {
    if (!value || Object.prototype.toString.call(value) !== '[object Object]') {
      fail(name + ' must be an object.');
    }
    Object.keys(value).forEach(function (key) {
      if (keys.indexOf(key) === -1) fail(name + ' contains an unsupported field: ' + key + '.');
    });
    keys.forEach(function (key) {
      if (!Object.prototype.hasOwnProperty.call(value, key)) fail(name + '.' + key + ' is required.');
    });
  }

  function identifier(value, name) {
    if (typeof value !== 'string' || !/^[A-Za-z0-9_.:-]{1,128}$/.test(value)) {
      fail(name + ' must be a short identifier.');
    }
    return value;
  }

  function number(value, name, minimum, maximum, integer) {
    if (typeof value !== 'number' || !Number.isFinite(value) || value < minimum || value > maximum ||
        (integer && !Number.isInteger(value))) fail(name + ' is outside its permitted range.');
    return value;
  }

  function dimensions(width, height) {
    number(width, 'Source width', 1, MAX_EDGE, true);
    number(height, 'Source height', 1, MAX_EDGE, true);
    if (width * height > MAX_PIXELS) fail('Source exceeds the pixel limit.');
  }

  function imageData(value) {
    if (typeof value !== 'string' || value.length > MAX_BASE64_BYTES + 32) {
      fail('Source must be a bounded embedded PNG or JPEG.');
    }
    var prefix = /^data:image\/(png|jpeg);base64,/.exec(value);
    if (!prefix) fail('Source must be an embedded PNG or JPEG data URL.');
    var base64 = value.slice(prefix[0].length);
    if (!base64.length || base64.length > MAX_BASE64_BYTES || base64.length % 4 !== 0 ||
        !/^[A-Za-z0-9+/]*={0,2}$/.test(base64)) fail('Source contains invalid base64 data.');
    var padding = base64.endsWith('==') ? 2 : base64.endsWith('=') ? 1 : 0;
    var last = BASE64_ALPHABET.indexOf(base64[base64.length - padding - 1]);
    if (last < 0 || (padding && (last & (padding === 2 ? 15 : 3)) !== 0)) {
      fail('Source contains noncanonical base64 data.');
    }
    return { mime: 'image/' + prefix[1], base64: base64 };
  }

  function textValue(value) {
    if (typeof value !== 'string' || value.length > MAX_TEXT_LENGTH * 2 || Array.from(value).length > MAX_TEXT_LENGTH) {
      fail('Label text exceeds the character limit.');
    }
    // XML cannot represent these controls or lone UTF-16 surrogates. Text is
    // otherwise kept verbatim, including accents and composed/decomposed forms.
    for (var character of value) {
      var point = character.codePointAt(0);
      if ((point < 32 && point !== 9 && point !== 10 && point !== 13) ||
          (point >= 0xD800 && point <= 0xDFFF) || point === 0xFFFE || point === 0xFFFF) {
        fail('Label text contains a character unavailable in SVG.');
      }
    }
    return value;
  }

  function color(value, name) {
    if (typeof value !== 'string' || !/^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i.test(value)) {
      fail(name + ' must be a hexadecimal color.');
    }
    return value;
  }

  function validate(project) {
    record(project, 'Project', ['schema', 'source', 'labels']);
    if (project.schema !== SCHEMA) fail('Unsupported image text project schema.');
    var source = project.source;
    record(source, 'Source', ['operationId', 'sha256', 'width', 'height', 'dataUrl']);
    identifier(source.operationId, 'Source operationId');
    if (typeof source.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(source.sha256)) {
      fail('Source SHA-256 must be a lowercase hexadecimal digest.');
    }
    dimensions(source.width, source.height);
    imageData(source.dataUrl);
    if (!Array.isArray(project.labels) || project.labels.length > MAX_LABELS) {
      fail('Project exceeds the label limit.');
    }
    var ids = new Set();
    var labels = project.labels.map(function (label) {
      record(label, 'Label', ['id', 'text', 'x', 'y', 'fontSize', 'color', 'background', 'align']);
      identifier(label.id, 'Label id');
      if (ids.has(label.id)) fail('Label identifiers must be unique.');
      ids.add(label.id);
      if (['left', 'center', 'right'].indexOf(label.align) === -1) fail('Unsupported text alignment.');
      return {
        id: label.id,
        text: textValue(label.text),
        x: number(label.x, 'Label x', 0, 1),
        y: number(label.y, 'Label y', 0, 1),
        fontSize: number(label.fontSize, 'Label font size', MIN_FONT_SIZE, MAX_FONT_SIZE),
        color: color(label.color, 'Label color'),
        background: label.background === null ? null : color(label.background, 'Label background'),
        align: label.align
      };
    });
    return {
      schema: SCHEMA,
      source: {
        operationId: source.operationId, sha256: source.sha256,
        width: source.width, height: source.height, dataUrl: source.dataUrl
      },
      labels: labels
    };
  }

  function create(source) { return validate({ schema: SCHEMA, source: source, labels: [] }); }

  function jsonSize(value) {
    // Most project bytes are ASCII base64. Only labels need extra UTF-8 bytes.
    var size = value.length;
    if (size > MAX_JSON_BYTES) fail('Project JSON exceeds the size limit.');
    for (var character of value) {
      var point = character.codePointAt(0);
      if (point > 0x7F) size += point > 0xFFFF ? 2 : point > 0x7FF ? 2 : 1;
      if (size > MAX_JSON_BYTES) fail('Project JSON exceeds the size limit.');
    }
  }

  function stringify(project) {
    var json = JSON.stringify(validate(project), null, 2);
    jsonSize(json);
    return json;
  }

  function parse(json) {
    if (typeof json !== 'string') fail('Project JSON must be text.');
    jsonSize(json);
    var project;
    try { project = JSON.parse(json); } catch (_error) { fail('Project JSON is invalid.'); }
    return validate(project);
  }

  function escapeXml(value) {
    return String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&apos;');
  }

  function font(label) { return label.fontSize + 'px ' + FONT_FAMILY; }

  function measurementContext() {
    if (cachedMeasurementContext !== undefined) return cachedMeasurementContext;
    cachedMeasurementContext = null;
    if (root.document && typeof root.document.createElement === 'function') {
      var canvas = root.document.createElement('canvas');
      if (typeof canvas.getContext === 'function') cachedMeasurementContext = canvas.getContext('2d');
    }
    return cachedMeasurementContext;
  }

  function layout(project, label, context) {
    var lines = label.text.split(/\r\n|\r|\n/);
    if (context) {
      context.font = font(label);
      context.textBaseline = 'alphabetic';
      context.fontKerning = 'normal';
    }
    var metrics = context && context.measureText('Mg');
    var ascent = metrics && Number.isFinite(metrics.fontBoundingBoxAscent)
      ? metrics.fontBoundingBoxAscent : label.fontSize * 0.9;
    var width = Math.max.apply(null, lines.map(function (line) {
      return context ? context.measureText(line).width : Array.from(line).length * label.fontSize * 0.65;
    }));
    var x = label.x * project.source.width;
    var y = label.y * project.source.height;
    var lineHeight = label.fontSize * 1.25;
    var offset = label.align === 'center' ? width / 2 : label.align === 'right' ? width : 0;
    var padding = label.fontSize * 0.2;
    return {
      lines: lines, x: x, y: y, baseline: y + ascent, lineHeight: lineHeight,
      background: { x: x - offset - padding, y: y - padding,
        width: width + padding * 2, height: label.fontSize + (lines.length - 1) * lineHeight + padding * 2 }
    };
  }

  function svg(project) {
    project = validate(project);
    var source = project.source;
    var parts = ['<svg xmlns="http://www.w3.org/2000/svg" width="' + source.width + '" height="' +
      source.height + '" viewBox="0 0 ' + source.width + ' ' + source.height + '">',
    '<title>Image text project</title>',
    '<image x="0" y="0" width="' + source.width + '" height="' + source.height +
      '" preserveAspectRatio="none" href="' + source.dataUrl + '"/>'];
    var context = measurementContext();
    project.labels.forEach(function (label) {
      var position = layout(project, label, context);
      parts.push('<g data-label-id="' + escapeXml(label.id) + '">');
      if (label.background) {
        var rectangle = position.background;
        parts.push('<rect x="' + rectangle.x + '" y="' + rectangle.y + '" width="' + rectangle.width +
          '" height="' + rectangle.height + '" fill="' + label.background + '"/>');
      }
      var anchor = label.align === 'center' ? 'middle' : label.align === 'right' ? 'end' : 'start';
      parts.push('<text fill="' + label.color + '" font-family="' + FONT_FAMILY + '" font-size="' +
        label.fontSize + '" text-anchor="' + anchor + '" font-kerning="normal" xml:space="preserve">');
      position.lines.forEach(function (line, index) {
        parts.push('<tspan x="' + position.x + '" y="' + (position.baseline + index * position.lineHeight) +
          '">' + escapeXml(line) + '</tspan>');
      });
      parts.push('</text></g>');
    });
    parts.push('</svg>');
    // Whitespace between tspans is rendered by xml:space and shifts centered
    // or right-aligned text; the SVG must not introduce its own label text.
    return parts.join('');
  }

  function draw(context, project, image) {
    project = validate(project);
    var width = image && (image.naturalWidth || image.width);
    var height = image && (image.naturalHeight || image.height);
    if (width !== project.source.width || height !== project.source.height) {
      fail('Decoded image dimensions do not match the source.');
    }
    if (!context || !context.canvas || context.canvas.width !== width || context.canvas.height !== height) {
      fail('Canvas dimensions do not match the source.');
    }
    context.save();
    try {
      // The renderer owns this complete canvas, independent of prior drawing state.
      context.setTransform(1, 0, 0, 1, 0, 0);
      context.globalAlpha = 1;
      context.globalCompositeOperation = 'source-over';
      context.shadowColor = 'transparent';
      context.shadowBlur = 0;
      context.shadowOffsetX = 0;
      context.shadowOffsetY = 0;
      if ('filter' in context) context.filter = 'none';
      context.clearRect(0, 0, width, height);
      context.drawImage(image, 0, 0, width, height);
      context.textBaseline = 'alphabetic';
      context.direction = 'ltr';
      project.labels.forEach(function (label) {
        var position = layout(project, label, context);
        if (label.background) {
          var rectangle = position.background;
          context.fillStyle = label.background;
          context.fillRect(rectangle.x, rectangle.y, rectangle.width, rectangle.height);
        }
        context.fillStyle = label.color;
        context.textAlign = label.align;
        position.lines.forEach(function (line, index) {
          context.fillText(line, position.x, position.baseline + index * position.lineHeight);
        });
      });
    } finally { context.restore(); }
  }

  function decodeBase64(base64) {
    var binary;
    if (typeof root.atob === 'function') binary = root.atob(base64);
    else if (typeof Buffer !== 'undefined') return new Uint8Array(Buffer.from(base64, 'base64'));
    else fail('Base64 decoding is unavailable.');
    var bytes = new Uint8Array(binary.length);
    for (var index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
    return bytes;
  }

  function readDimensions(bytes, mime) {
    var width, height;
    if (mime === 'image/png') {
      var signature = [137, 80, 78, 71, 13, 10, 26, 10];
      if (bytes.length < 33 || signature.some(function (value, index) { return bytes[index] !== value; }) ||
          bytes[8] !== 0 || bytes[9] !== 0 || bytes[10] !== 0 || bytes[11] !== 13 ||
          bytes[12] !== 73 || bytes[13] !== 72 || bytes[14] !== 68 || bytes[15] !== 82) {
        fail('Source does not contain a PNG header.');
      }
      var view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      width = view.getUint32(16); height = view.getUint32(20);
    } else {
      if (bytes.length < 4 || bytes[0] !== 255 || bytes[1] !== 216) fail('Source does not contain a JPEG header.');
      var offset = 2;
      while (offset < bytes.length) {
        if (bytes[offset++] !== 255) fail('Source contains an invalid JPEG header.');
        while (bytes[offset] === 255) offset += 1;
        var marker = bytes[offset++];
        if (marker === 217 || marker === 218 || marker == null) break;
        if (marker === 1 || (marker >= 208 && marker <= 215)) continue;
        if (offset + 2 > bytes.length) fail('Source contains a truncated JPEG header.');
        var length = bytes[offset] * 256 + bytes[offset + 1];
        if (length < 2 || offset + length > bytes.length) fail('Source contains a truncated JPEG segment.');
        if ([192, 193, 194, 195, 197, 198, 199, 201, 202, 203, 205, 206, 207].indexOf(marker) !== -1) {
          if (length < 8) fail('Source contains an invalid JPEG frame.');
          height = bytes[offset + 3] * 256 + bytes[offset + 4];
          width = bytes[offset + 5] * 256 + bytes[offset + 6];
          break;
        }
        offset += length;
      }
      if (width == null || height == null) fail('Source does not contain JPEG dimensions.');
    }
    dimensions(width, height);
    return { width: width, height: height };
  }

  // A local/LAN HTTP origin may not have SubtleCrypto. This bounded SHA-256
  // fallback keeps reopening and integrity checks available on that origin.
  function sha256Fallback(bytes) {
    var constants = [0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
      0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
      0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
      0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
      0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
      0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
      0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
      0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2];
    var state = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19];
    var words = new Uint32Array(64);
    var length = Math.ceil((bytes.length + 9) / 64) * 64;
    var bitLength = bytes.length * 8;
    function rotate(value, amount) { return (value >>> amount) | (value << (32 - amount)); }
    function byteAt(index) {
      if (index < bytes.length) return bytes[index];
      if (index === bytes.length) return 128;
      if (index >= length - 4) return (bitLength >>> ((length - 1 - index) * 8)) & 255;
      return 0;
    }
    for (var offset = 0; offset < length; offset += 64) {
      for (var index = 0; index < 16; index += 1) {
        var start = offset + index * 4;
        words[index] = (byteAt(start) << 24) | (byteAt(start + 1) << 16) |
          (byteAt(start + 2) << 8) | byteAt(start + 3);
      }
      for (var next = 16; next < 64; next += 1) {
        var previous = words[next - 15], recent = words[next - 2];
        var small0 = rotate(previous, 7) ^ rotate(previous, 18) ^ (previous >>> 3);
        var small1 = rotate(recent, 17) ^ rotate(recent, 19) ^ (recent >>> 10);
        words[next] = (words[next - 16] + small0 + words[next - 7] + small1) >>> 0;
      }
      var a = state[0], b = state[1], c = state[2], d = state[3];
      var e = state[4], f = state[5], g = state[6], h = state[7];
      for (var round = 0; round < 64; round += 1) {
        var sigma1 = rotate(e, 6) ^ rotate(e, 11) ^ rotate(e, 25);
        var choice = (e & f) ^ (~e & g);
        var temporary1 = (h + sigma1 + choice + constants[round] + words[round]) >>> 0;
        var sigma0 = rotate(a, 2) ^ rotate(a, 13) ^ rotate(a, 22);
        var majority = (a & b) ^ (a & c) ^ (b & c);
        var temporary2 = (sigma0 + majority) >>> 0;
        h = g; g = f; f = e; e = (d + temporary1) >>> 0;
        d = c; c = b; b = a; a = (temporary1 + temporary2) >>> 0;
      }
      [a, b, c, d, e, f, g, h].forEach(function (value, index) { state[index] = (state[index] + value) >>> 0; });
    }
    return state.map(function (value) { return value.toString(16).padStart(8, '0'); }).join('');
  }

  async function hashBytes(bytes, options) {
    if (!(bytes instanceof Uint8Array) || bytes.length > MAX_BASE64_BYTES * 3 / 4) {
      fail('Hash input must be bounded bytes.');
    }
    var crypto = options && Object.prototype.hasOwnProperty.call(options, 'crypto') ? options.crypto : root.crypto;
    if (crypto && crypto.subtle && typeof crypto.subtle.digest === 'function') {
      var digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
      return Array.from(digest).map(function (value) { return value.toString(16).padStart(2, '0'); }).join('');
    }
    return sha256Fallback(bytes);
  }

  async function verifySource(project, options) {
    project = validate(project);
    var data = imageData(project.source.dataUrl);
    var bytes = decodeBase64(data.base64);
    var size = readDimensions(bytes, data.mime);
    if (size.width !== project.source.width || size.height !== project.source.height) {
      fail('Source dimensions do not match the embedded image.');
    }
    var hash = await hashBytes(bytes, options);
    if (hash !== project.source.sha256) fail('Source SHA-256 does not match the embedded image.');
    return { mime: data.mime, width: size.width, height: size.height, sha256: hash };
  }

  return {
    SCHEMA: SCHEMA, MAX_JSON_BYTES: MAX_JSON_BYTES, MAX_BASE64_BYTES: MAX_BASE64_BYTES,
    MAX_LABELS: MAX_LABELS, MAX_TEXT_LENGTH: MAX_TEXT_LENGTH, MAX_EDGE: MAX_EDGE, MAX_PIXELS: MAX_PIXELS,
    MIN_FONT_SIZE: MIN_FONT_SIZE, MAX_FONT_SIZE: MAX_FONT_SIZE, FONT_FAMILY: FONT_FAMILY,
    create: create, validate: validate, stringify: stringify, parse: parse,
    svg: svg, draw: draw, hashBytes: hashBytes, verifySource: verifySource
  };
});
