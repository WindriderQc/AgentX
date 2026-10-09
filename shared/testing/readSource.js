'use strict';

const fs = require('fs');
const path = require('path');

const RELATIVE_IMPORT = /^@import url\("([^"/][^"]*)"\);[ \t]*$/gm;

// Reads a source file for content assertions. A stylesheet split into
// relative @import parts is returned with its parts inlined in order, which is
// the set of rules a browser applies.
function readSource(file) {
  const text = fs.readFileSync(file, 'utf8');
  if (!file.endsWith('.css')) return text;
  return text.replace(RELATIVE_IMPORT, (_line, relative) => readSource(path.join(path.dirname(file), relative)));
}

module.exports = { readSource };
