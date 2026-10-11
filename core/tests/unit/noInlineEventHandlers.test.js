const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '../..');

// Helmet sets script-src-attr 'none': an inline handler such as onclick="…"
// never runs, so the control silently does nothing.
const INLINE_HANDLER = /\son[a-z]+\s*=\s*["']/g;

function sources(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) return ['node_modules', 'dist', 'test', 'tests'].includes(entry.name) ? [] : sources(file);
    return /\.(ejs|html|js)$/.test(entry.name) ? [file] : [];
  });
}

describe('inline event handlers', () => {
  test('browser code binds listeners instead of inline handler attributes', () => {
    const offenders = ['views', 'public', 'surfaces']
      .flatMap(dir => sources(path.join(root, dir)))
      .flatMap((file) => {
        const text = fs.readFileSync(file, 'utf8');
        return [...text.matchAll(INLINE_HANDLER)].map((match) => {
          const line = text.slice(0, match.index).split('\n').length;
          return `${path.relative(root, file)}:${line}`;
        });
      });
    expect(offenders).toEqual([]);
  });
});
