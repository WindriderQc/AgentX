'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const source = fs.readFileSync(
  path.resolve(__dirname, '../../public/js/chat/chat-rag-sources.js'),
  'utf8'
).replace(/^export /gm, '');

function makeElement(tag) {
  return {
    tag, children: [], style: {}, attributes: {}, className: '',
    appendChild(child) { this.children.push(child); return child; },
    setAttribute(name, value) { this.attributes[name] = value; },
    addEventListener() {},
    querySelector() { return { style: {} }; },
    get textContent() { return this.children.map(c => c.textContent || c.text || '').join(''); }
  };
}

function loadDisplay() {
  const context = vm.createContext({
    document: {
      createElement: makeElement,
      createTextNode: text => ({ text })
    }
  });
  vm.runInContext(`${source}\nthis.appendRagDisplay = appendRagDisplay;`, context);
  return context.appendRagDisplay;
}

describe('chat RAG display', () => {
  test('shows a notice when retrieval was requested but unavailable', () => {
    const appendRagDisplay = loadDisplay();
    const bubble = makeElement('div');
    appendRagDisplay(bubble, { metadata: { ragStatus: 'unavailable' } }, jest.fn());
    expect(bubble.children).toHaveLength(1);
    expect(bubble.children[0].className).toBe('rag-unavailable-notice');
    expect(bubble.children[0].textContent).toContain('Knowledge base unavailable');
  });

  test('shows nothing for a request with no match or no RAG', () => {
    const appendRagDisplay = loadDisplay();
    for (const ragStatus of ['no_match', 'not_requested', undefined]) {
      const bubble = makeElement('div');
      appendRagDisplay(bubble, { ragStatus, ragSources: [] }, jest.fn());
      expect(bubble.children).toHaveLength(0);
    }
  });

  test('still renders citations when sources are present', () => {
    const appendRagDisplay = loadDisplay();
    const bubble = makeElement('div');
    appendRagDisplay(bubble, {
      ragStatus: 'used',
      ragSources: [{ score: 0.8, excerpt: 'Synthetic excerpt', metadata: { filename: 'doc.md' } }]
    }, jest.fn());
    expect(bubble.children).toHaveLength(1);
    expect(bubble.children[0].className).toBe('message-citations');
  });
});
