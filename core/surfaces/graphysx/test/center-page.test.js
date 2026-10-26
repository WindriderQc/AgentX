const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function page() {
  const listeners = new Map();
  const status = { hidden: true, textContent: '', error: false };
  status.classList = { toggle: (_name, enabled) => { status.error = enabled; } };
  const center = { addEventListener: (name, handler) => listeners.set(name, handler) };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../public/center-page.js'), 'utf8'), {
    document: { getElementById: () => status, querySelector: () => center },
    window: { customElements: { get: () => true } }, setTimeout: () => 0
  });
  return { status, emit: (name, detail) => listeners.get(`graphysx-center-${name}`)?.({ detail }) };
}

test('accepted push replaces the pending invitation with its historical revision and commit', () => {
  const p = page();
  p.emit('receipt', { id: 'push-1', status: 'shown' });
  assert.match(p.status.textContent, /décider/);
  p.emit('outcome', { id: 'push-1', status: 'accepted', revision: 9, commitId: 'commit-0007' });
  assert.match(p.status.textContent, /accepté.*révision 9/);
  assert.match(p.status.textContent, /commit-0007/);
  assert.doesNotMatch(p.status.textContent, /décider/);
  assert.equal(p.status.hidden, false);
  assert.equal(p.status.error, false);
});

test('discarded push no longer asks for a decision or claims an applied change', () => {
  const p = page();
  p.emit('receipt', { id: 'push-2', status: 'shown' });
  p.emit('outcome', { id: 'push-2', status: 'discarded', revision: 10 });
  assert.match(p.status.textContent, /écartée/);
  assert.match(p.status.textContent, /aucun changement appliqué par cette proposition/);
  assert.doesNotMatch(p.status.textContent, /décider/);
  assert.equal(p.status.error, false);
});

test('stale and rejected decisions show refusal while malformed decisions preserve the receipt', () => {
  const p = page();
  p.emit('outcome', { status: 'stale', revision: 11 });
  assert.match(p.status.textContent, /périmée.*révision 11/);
  assert.equal(p.status.error, true);
  const reason = '<b>invalid geometry</b>'.repeat(30);
  p.emit('outcome', { status: 'rejected', revision: 12, reason });
  assert.match(p.status.textContent, /refusé.*révision 12/);
  assert.ok(p.status.textContent.includes(reason.slice(0, 300)));
  assert.ok(p.status.textContent.length < 400, 'untrusted reasons stay bounded textContent');
  const previous = p.status.textContent;
  for (const detail of [null, { status: 'accepted' }, { status: 'accepted', revision: -1 }, { status: 'invented', revision: 13 }]) p.emit('outcome', detail);
  assert.equal(p.status.textContent, previous);
});
