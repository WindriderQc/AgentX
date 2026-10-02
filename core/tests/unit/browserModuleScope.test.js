'use strict';

const fs = require('fs');
const path = require('path');
const parser = require('@babel/parser');
const traverse = require('@babel/traverse').default;

// Browser ES modules are not executed by the test suite. A name a module uses
// but neither declares nor imports only fails in the browser, on the code path
// that reaches it (a dropped import, a variable left in another module, a
// const scoped to a try block). Every free name must be a known global.
const PUBLIC_JS = path.resolve(__dirname, '../../public/js');

// Scripts the pages load before their modules.
const PAGE_GLOBALS = new Set([
  'Chart', 'ChatContextIndicator', 'ChatIntelligence', 'DOMPurify', 'ShortcutsHelpModal', 'Toast', 'hljs', 'marked'
]);

const BROWSER_GLOBALS = new Set([
  'window', 'document', 'navigator', 'location', 'history', 'localStorage', 'sessionStorage', 'CSS',
  'HTMLElement', 'Element', 'Node', 'Event', 'CustomEvent', 'KeyboardEvent', 'MouseEvent', 'EventSource',
  'MutationObserver', 'IntersectionObserver', 'ResizeObserver', 'DOMParser', 'Image', 'Audio', 'Option',
  'requestAnimationFrame', 'cancelAnimationFrame', 'getComputedStyle', 'matchMedia', 'alert', 'confirm',
  'prompt', 'open', 'Blob', 'File', 'FileReader', 'FormData', 'MediaRecorder', 'AudioContext',
  'speechSynthesis', 'SpeechSynthesisUtterance', 'Notification', 'innerWidth', 'innerHeight', 'screen',
  'self', 'crypto', 'fetch', 'Request', 'Response', 'Headers', 'AbortController', 'AbortSignal'
]);

function browserModules(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) return browserModules(file);
    if (!entry.name.endsWith('.js')) return [];
    const source = fs.readFileSync(file, 'utf8');
    return /^(?:import|export) /m.test(source) ? [[path.relative(PUBLIC_JS, file).replace(/\\/g, '/'), source]] : [];
  });
}

function freeNames(source) {
  const ast = parser.parse(source, { sourceType: 'module' });
  const names = new Set();
  traverse(ast, {
    ReferencedIdentifier(nodePath) {
      const { name } = nodePath.node;
      if (nodePath.scope.hasBinding(name, true)) return;
      if (name in globalThis || BROWSER_GLOBALS.has(name) || PAGE_GLOBALS.has(name)) return;
      names.add(`${name}@${nodePath.node.loc.start.line}`);
    }
  });
  return [...names];
}

const modules = browserModules(PUBLIC_JS);

test('finds the browser ES modules', () => {
  expect(modules.map(([file]) => file)).toEqual(expect.arrayContaining([
    'chat/chat-messaging.js', 'analytics-cost.js'
  ]));
});

describe('browser ES modules only use declared, imported or global names', () => {
  test.each(modules)('%s', (_file, source) => {
    expect(freeNames(source)).toEqual([]);
  });
});
