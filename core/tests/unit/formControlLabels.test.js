const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '../..');

// Static templates whose form controls a screen reader must be able to name.
function templates() {
  const pages = fs.readdirSync(path.join(root, 'views/pages'))
    .filter(name => name.endsWith('.ejs'))
    .map(name => path.join('views/pages', name));
  const surfaces = fs.readdirSync(path.join(root, 'surfaces'))
    .map(name => path.join('surfaces', name, 'public/index.html'))
    .filter(file => fs.existsSync(path.join(root, file)));
  return [...pages, ...surfaces];
}

const UNNAMED_TYPES = new Set(['hidden', 'submit', 'button', 'reset', 'image']);

function unlabeledControls(html) {
  const labelFor = new Set([...html.matchAll(/<label\b[^>]*\bfor="([^"]+)"/g)].map(match => match[1]));
  const problems = [];
  for (const match of html.matchAll(/<(input|select|textarea)\b([^>]*)>/g)) {
    const [tag, name, attrs] = match;
    const type = (attrs.match(/\btype="([^"]+)"/) || [])[1];
    if (name === 'input' && UNNAMED_TYPES.has(type)) continue;
    if (/\baria-label(ledby)?="/.test(attrs)) continue;
    const id = (attrs.match(/\bid="([^"]+)"/) || [])[1];
    if (id && labelFor.has(id)) continue;
    const before = html.slice(0, match.index);
    if (before.lastIndexOf('<label') > before.lastIndexOf('</label>')) continue;
    problems.push(tag.slice(0, 90));
  }
  return problems;
}

describe('form controls in page templates', () => {
  test.each(templates())('%s names every form control', (file) => {
    const html = fs.readFileSync(path.join(root, file), 'utf8');
    expect(unlabeledControls(html)).toEqual([]);
  });
});
