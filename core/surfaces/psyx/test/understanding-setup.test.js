'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function browser(file, extras = {}) {
  const elements = new Map();
  const element = id => {
    if (!elements.has(id)) elements.set(id, {
      innerHTML: '', textContent: '', hidden: false, disabled: false, listeners: {},
      replaceChildren() { this.innerHTML = ''; },
      addEventListener(kind, callback) { this.listeners[kind] = callback; }
    });
    return elements.get(id);
  };
  const context = { console, Map, Set, Date, Number, Object,
    state: { psyxState: null, voice: { reachable: false }, routing: null },
    window: { isSecureContext: true }, navigator: { mediaDevices: { getUserMedia: async () => ({ getTracks: () => [] }) } },
    $: element, escapeHtml: value => String(value).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]),
    SOURCE_LABELS: { user: 'you', psyx: 'PsyX' }, ...extras
  };
  vm.createContext(context);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'public', file), 'utf8'), context);
  return { context, element };
}

test('understanding escapes statements and provenance, separates proposals, and clears private drafts when state is cleared', () => {
  const { context: b, element } = browser('formulation.js');
  b.state.psyxState = { revision: 7, patterns: [{ id: 'p', text: '<img onerror="bad()">', evidence: ['<script>private evidence</script>'], source: 'psyx', sourceConversationId: 'source"session' }],
    proposals: [{ text: 'Unapproved hypothesis', evidence: ['Pending evidence'], conversationId: 'pending-source' }] };
  b.renderFormulation();
  const html = element('formulationList').innerHTML;
  assert.doesNotMatch(html, /<img|<script/);
  assert.match(html, /&lt;script&gt;private evidence/);
  assert.match(html, /source&quot;session/);
  assert.match(html, /not yet part of the memory/);
  b.wireFormulation();
  element('formulationList').listeners.input({ target: { value: 'Private unfinished correction', closest: () => ({ dataset: { formulationKey: 'patterns', formulationId: 'p', formulationRevision: '7' } }) } });
  b.state.psyxState.revision = 8;
  b.renderFormulation();
  assert.match(element('formulationList').innerHTML, /Private unfinished correction/);
  assert.match(element('formulationList').innerHTML, /data-formulation-revision="7"/);
  const original = b.state.psyxState;
  b.state.psyxState = null;
  b.renderFormulation();
  assert.doesNotMatch(element('formulationList').innerHTML, /private evidence|Private unfinished/);
  b.state.psyxState = original;
  b.renderFormulation();
  assert.doesNotMatch(element('formulationList').innerHTML, /Private unfinished/);
});

test('setup distinguishes disabled voice, LAN access, insecure capture and local-only frontier', () => {
  const { context: b, element } = browser('setup.js');
  b.window.isSecureContext = false;
  b.setSetupCapabilities({ privacy: { configured: false }, voice: { enabled: false }, review: { automatic: true } });
  assert.match(element('setupChecklist').innerHTML, /Private LAN: no account or code required/);
  assert.match(element('setupChecklist').innerHTML, /Optional, not configured/);
  assert.match(element('setupChecklist').innerHTML, /HTTPS or localhost required/);
  assert.match(element('setupChecklist').innerHTML, /Off: replies and reviews/);
  assert.equal(element('testSetupMicrophone').disabled, true);
  b.clearSetup();
  assert.equal(element('setupChecklist').innerHTML, '');
});
