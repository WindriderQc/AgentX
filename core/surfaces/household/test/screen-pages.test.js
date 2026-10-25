'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const pages = require('../../../public/js/screen-pages');
const registerPipelinePage = require('../../../routes/pipeline-page');

test('only known pages and focus values survive parsing', () => {
  assert.deepEqual(pages.parse('pipeline status=blocked task=812'), { page: 'pipeline', focus: { status: 'blocked', task: '812' } });
  assert.deepEqual(pages.parse('pipeline status=everything task=../x owner=me'), { page: 'pipeline', focus: {} });
  assert.equal(pages.parse('constructor'), null);
  assert.equal(pages.parse('https://example.org'), null);
  assert.equal(pages.url(pages.parse('pipeline status=review')), '/pipeline?view=screen&from=nestor&status=review');
});

test('a DiskX page carries a validated animation list to its screen URL', () => {
  const catalog = pages.createCatalog([{ id: 'diskx', label: 'DiskX', href: '/diskx?janitor=latest', mode: 'frame' }]);
  const target = catalog.parse('diskx play=Duplicates,pairs,tour-5');
  assert.deepEqual(target, { page: 'diskx', focus: { play: 'duplicates,pairs,tour-5' } });
  assert.equal(catalog.url(target), '/diskx?janitor=latest&view=screen&from=nestor&play=duplicates%2Cpairs%2Ctour-5');
  assert.deepEqual(catalog.parse('diskx play=duplicates,delete'), { page: 'diskx', focus: {} }, 'an unknown step drops the list');
  assert.equal(pages.diskxPlay('tour-21'), null);
  assert.equal(pages.diskxPlay(`group-${'a'.repeat(64)},summary`), `group-${'a'.repeat(64)},summary`);
});

function renderPipeline(query, policy) {
  const routes = {};
  registerPipelinePage({ get: (path, handler) => { routes[path] = handler; } });
  const headers = new Map(policy ? [['content-security-policy', policy]] : []);
  const res = {
    setHeader: (name, value) => headers.set(name.toLowerCase(), value),
    getHeader: name => headers.get(name.toLowerCase()),
    render: (_view, locals) => { res.locals = locals; }
  };
  routes['/pipeline']({ query }, res);
  return { headers, locals: res.locals };
}

test('only the screen view may be framed, and only by AgentX itself', () => {
  const policy = "default-src 'self'; frame-ancestors 'none'; script-src-attr 'none'";
  const screen = renderPipeline({ view: 'screen' }, policy);
  assert.equal(screen.headers.get('x-frame-options'), 'SAMEORIGIN');
  assert.equal(screen.headers.get('content-security-policy'), "default-src 'self'; frame-ancestors 'self'; script-src-attr 'none'");
  assert.equal(screen.locals.showNav, false);
  assert.equal(screen.locals.bodyClass, 'pipeline-screen');
  const full = renderPipeline({}, policy);
  assert.equal(full.headers.get('x-frame-options'), undefined);
  assert.equal(full.headers.get('content-security-policy'), policy);
  assert.equal(full.locals.showNav, undefined);
});
