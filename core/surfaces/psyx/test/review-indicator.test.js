'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function browser(status) {
  const nodes = new Map();
  const context = { state: { conversationId: 'c', psyxState: { proposals: [] } }, clearTimeout, setTimeout,
    api: async () => status, loadPsyXState: async () => {}, loadSessions: async () => {},
    $: id => {
      if (!nodes.has(id)) nodes.set(id, { hidden: true, classList: { toggle() {} }, dataset: {} });
      return nodes.get(id);
    } };
  vm.createContext(context);
  const source = fs.readFileSync(path.join(__dirname, '../public/review.js'), 'utf8');
  vm.runInContext(source + '\nreview.enabled = true;', context);
  return { context, nodes };
}

test('an uncertain dispatch remains visible after restoring a session instead of implying completion', async () => {
  const { context, nodes } = browser({ enabled: true, status: 'uncertain', coverage: { pendingReplies: 2 } });
  await vm.runInContext("resumeReviewStatus('c')", context);
  const chip = nodes.get('reviewStatus');
  assert.equal(chip.hidden, false);
  assert.equal(chip.textContent, 'La revue est en attente de vérification');
  assert.match(chip.title, /ne sera pas relancé automatiquement/);
  assert.match(chip.title, /réponses en attente restent enregistrées/);
});
