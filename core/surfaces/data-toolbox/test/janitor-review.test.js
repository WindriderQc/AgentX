'use strict';

// The Janitor duplicate review: the relay's validation and the tab (save, undo,
// import of a browser draft, stale display, paging, fallback, hostile paths).
// Synthetic paths and hashes only; Data is a stub.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const toolbox = require('../index');
const relay = require('../janitor-review-relay');
const rules = require('../../../../shared/janitorReviewDecisionRules');

const publicRoot = path.resolve(__dirname, '..', 'public');
const sha = (n) => n.toString(16).padStart(64, '0');
const A = '/mnt/datalake/example/a.bin';
const B = '/mnt/datalake/example/copy/a.bin';
const HOSTILE = '/mnt/media/<img src=x onerror=alert(1)>/"quoted" & \'single\'.bin';
const REPORT = { id: 'a'.repeat(24), generatedAt: '2026-10-08T07:00:00.000Z', status: 'ready_for_review', duplicateSurvivorRule: 'canonical_active' };

// ------------------------------------------------------------------- relay

function relayApp(t, respond = () => ({ status: 200, body: { status: 'success', data: {} } })) {
  const express = require('express');
  const original = global.fetch;
  const calls = [];
  t.after(() => { global.fetch = original; });
  global.fetch = async (url, options = {}) => {
    calls.push({ url: String(url), method: options.method || 'GET', body: options.body ? JSON.parse(options.body) : undefined });
    const answer = await respond(calls.at(-1));
    return { ok: answer.status < 400, status: answer.status, text: async () => JSON.stringify(answer.body) };
  };
  const app = express();
  app.use(express.json());
  toolbox.register({ contractVersion: 2, app, express });
  return { app, calls, request: require('supertest')(app) };
}

const decisionBody = (overrides = {}) => ({ decision: 'dedupe', survivorPath: A, evidence: { size: 1000, paths: [B, A] }, ...overrides });

test('a decision is checked, normalized and forwarded to Data with only its checked fields', async (t) => {
  const { calls, request } = relayApp(t);
  await request.put(`/api/data-toolbox/janitor/review-decisions/${sha(1)}`)
    .send(decisionBody({ note: '  keep the first  ', evidence: { size: 1000, paths: [B, A], reportId: REPORT.id, reportGeneratedAt: REPORT.generatedAt } })).expect(200);
  assert.equal(calls.length, 1);
  assert.match(calls[0].url, new RegExp(`/api/v1/janitor/profiles/shared-drive/review-decisions/${sha(1)}$`));
  assert.equal(calls[0].method, 'PUT');
  assert.deepEqual(calls[0].body, {
    decision: 'dedupe', survivorPath: A, note: 'keep the first', source: 'toolbox',
    evidence: { size: 1000, paths: [A, B], reportId: REPORT.id, reportGeneratedAt: REPORT.generatedAt }
  });
});

test('the relay refuses what Data would refuse, before calling it', async (t) => {
  const { calls, request } = relayApp(t);
  const refused = [
    [sha(1), decisionBody({ survivorPath: '/mnt/media/elsewhere' }), /survivorPath must be one of evidence\.paths/],
    [sha(1), decisionBody({ evidence: { size: 1000, paths: [A, '/etc/passwd'] } }), /must be under one of/],
    [sha(1), decisionBody({ evidence: { size: 1000, paths: [A, '/mnt/datalake/../../etc/passwd'] } }), /normalized/],
    [sha(1), decisionBody({ approve: true }), /unknown decision field "approve"/],
    [sha(1), decisionBody({ evidence: { size: 1000, paths: [A, B], preview_id: 'x' } }), /unknown evidence field "preview_id"/],
    [sha(1), decisionBody({ decision: 'delete' }), /decision must be one of/],
    [sha(1), decisionBody({ evidence: { size: -1, paths: [A, B] } }), /evidence\.size/],
    [sha(1), decisionBody({ note: 'x'.repeat(501) }), /note must be at most 500/],
    [sha(1), decisionBody({ sha256: sha(2) }), /must match the one in the address/],
    ['not-a-hash', decisionBody(), /sha256 must be 64 lowercase/],
    [sha(1), [], /JSON object/]
  ];
  for (const [id, body, message] of refused) {
    const res = await request.put(`/api/data-toolbox/janitor/review-decisions/${id}`).send(body).expect(400);
    assert.equal(res.body.code, 'INVALID_REVIEW_DECISION');
    assert.match(res.body.message, message);
  }
  await request.delete('/api/data-toolbox/janitor/review-decisions/not-a-hash').expect(400);
  await request.delete(`/api/data-toolbox/janitor/review-decisions/${'A'.repeat(64)}`).expect(400);
  const entry = (n) => ({ sha256: sha(n), ...decisionBody() });
  for (const body of [
    { decisions: Array.from({ length: 201 }, (_, index) => entry(index + 1)) },
    { decisions: [] }, { decisions: [entry(1), entry(1)] }, { decisions: [entry(1)], mode: 'replace_all' },
    { decisions: [entry(1)], confirm: true }, { decisions: [entry(1), { ...entry(2), decision: 'delete' }] }
  ]) {
    const res = await request.post('/api/data-toolbox/janitor/review-decisions/batch').send(body).expect(400);
    assert.equal(res.body.code, 'INVALID_REVIEW_DECISION_BATCH');
  }
  for (const query of ['limit=201', 'state=fresh', 'decision=delete', 'pathPrefix=/etc', 'sha256=nope', 'sort=asc']) {
    await request.get(`/api/data-toolbox/janitor/review-decisions?${query}`).expect(400);
  }
  for (const query of ['limit=51', 'limit=all', 'offset=-1', 'review=decided', 'sha256=nope', 'files=9999']) {
    await request.get(`/api/data-toolbox/janitor/strategy/latest/groups?${query}`).expect(400);
  }
  assert.equal(calls.length, 0, 'nothing invalid reaches Data');
});

test('the batch, the removal and the list reach only the review-decision routes', async (t) => {
  const { calls, request } = relayApp(t);
  await request.post('/api/data-toolbox/janitor/review-decisions/batch')
    .send({ mode: 'insert_missing', decisions: [{ sha256: sha(1), ...decisionBody({ source: 'browser-draft-import' }) }, { sha256: sha(2), decision: 'keep_all', evidence: { size: 5, paths: [A, B] } }] }).expect(200);
  await request.delete(`/api/data-toolbox/janitor/review-decisions/${sha(1)}`).expect(200);
  await request.get(`/api/data-toolbox/janitor/review-decisions?state=stale&limit=50&pathPrefix=/mnt/media/&sha256=${sha(1)},${sha(2)}`).expect(200);
  assert.deepEqual(calls.map((call) => `${call.method} ${new URL(call.url).pathname}`), [
    'POST /api/v1/janitor/profiles/shared-drive/review-decisions/batch',
    `DELETE /api/v1/janitor/profiles/shared-drive/review-decisions/${sha(1)}`,
    'GET /api/v1/janitor/profiles/shared-drive/review-decisions'
  ]);
  assert.deepEqual(calls[0].body, { mode: 'insert_missing', decisions: [
    { sha256: sha(1), decision: 'dedupe', survivorPath: A, note: null, source: 'browser-draft-import', evidence: { size: 1000, paths: [A, B], reportId: null, reportGeneratedAt: null } },
    { sha256: sha(2), decision: 'keep_all', note: null, source: 'toolbox', evidence: { size: 5, paths: [A, B], reportId: null, reportGeneratedAt: null } }
  ] });
  assert.equal(new URL(calls[2].url).search, `?state=stale&pathPrefix=%2Fmnt%2Fmedia&sha256=${sha(1)}%2C${sha(2)}&limit=50&offset=0`);
  // The janitor's approval, rejection and run routes are not relayed at all.
  for (const [method, route] of [['post', '/janitor/runs/abc/actions/0/approve'], ['post', '/janitor/runs/abc/actions/0/reject'], ['post', '/janitor/profiles/abc/run'], ['put', '/janitor/policy'], ['post', '/janitor/strategy']]) {
    await request[method](`/api/data-toolbox${route}`).send({ confirm: true }).expect(404);
  }
  assert.equal(calls.length, 3);
});

test('a write Data did not answer says the outcome is unknown', async (t) => {
  const { request } = relayApp(t, () => { const error = new Error('aborted'); error.name = 'TimeoutError'; throw error; });
  const res = await request.put(`/api/data-toolbox/janitor/review-decisions/${sha(1)}`).send(decisionBody()).expect(502);
  assert.equal(res.body.code, 'DATA_TIMEOUT');
  assert.match(res.body.message, /may or may not have been saved/);
});

test('a page of groups is bounded: at most 50 groups and 60 copies each, with the rest counted', async (t) => {
  const many = Array.from({ length: 75 }, (_, index) => ({ path: `/mnt/media/many/${index}`, mtime: 1, storageRole: null }));
  const groups = Array.from({ length: 60 }, (_, index) => ({ sha256: sha(index + 1), size: 10, count: 2, provenSavingsBytes: 10, position: index, files: [{ path: A }, { path: B }], review: null, secret: 'not forwarded' }));
  groups[0] = { ...groups[0], count: 75, files: many, review: { decision: 'dedupe', survivorPath: HOSTILE, state: 'stale', staleReasons: Array.from({ length: 20 }, () => ({ code: 'new_copies', detail: 'x', count: 9, paths: [HOSTILE, A, B, A] })), authorizesFilesystemMutation: true } };
  const { calls, request } = relayApp(t, () => ({ status: 200, body: { status: 'success', data: { report: REPORT, total: 48157, offset: 30, limit: 50, review: 'undecided', nextOffset: 80, scanned: 50, groups } } }));
  const res = await request.get('/api/data-toolbox/janitor/strategy/latest/groups?offset=30&limit=50&review=undecided').expect(200);
  assert.equal(new URL(calls[0].url).search, '?offset=30&limit=50&review=undecided');
  const page = res.body.data;
  assert.equal(page.groups.length, 50);
  assert.equal(page.total, 48157);
  assert.equal(page.nextOffset, 80);
  assert.equal(page.groups[0].files.length, relay.GROUP_FILE_LIMIT);
  assert.equal(page.groups[0].filesOmitted, 15);
  assert.equal(page.groups[1].secret, undefined);
  assert.equal(page.groups[0].review.staleReasons.length, 8);
  assert.equal(page.groups[0].review.staleReasons[0].paths.length, 3);
  // A mark never claims to authorize anything, whatever Data sent.
  assert.equal(page.groups[0].review.authorizesFilesystemMutation, false);
  assert.deepEqual(relay.checkGroupsQuery({}).value, { offset: 0, limit: 30, review: 'all' });
});

test('the relay and Data check a decision with the same rules', () => {
  const dataService = fs.readFileSync(path.resolve(__dirname, '../../../../data/services/janitorReviewDecisions.js'), 'utf8');
  const coreRelay = fs.readFileSync(path.resolve(__dirname, '../janitor-review-relay.js'), 'utf8');
  assert.match(dataService, /require\('\.\.\/\.\.\/shared\/janitorReviewDecisionRules'\)/);
  assert.match(coreRelay, /require\('\.\.\/\.\.\/\.\.\/shared\/janitorReviewDecisionRules'\)/);
  assert.deepEqual([...rules.DECISIONS], ['keep_all', 'dedupe', 'defer']);
  assert.equal(rules.LIMITS.batch, 200);
});

// --------------------------------------------------------------------- tab

const body = (data, status = 200) => ({ ok: status < 400, status, json: async () => (status < 400 ? { status: 'success', data } : { status: 'error', message: data }) });
const group = (n, files = [A, B], extra = {}) => ({
  sha256: sha(n), position: n - 1, proof: 'sha256-current-metadata', size: 1000, count: files.length, provenSavingsBytes: 1000 * (files.length - 1),
  files: files.map((file) => ({ path: file, mtime: 1, storageRole: null })), filesOmitted: 0, policySurvivorPath: files[0], review: null, ...extra
});
const summaryOf = (overrides = {}) => ({
  total: 0, evaluated: 0, truncated: false, byDecision: { keep_all: 0, dedupe: 0, defer: 0 }, current: 0, stale: 0, staleByReason: {},
  dedupe: { current: 0, stale: 0, reclaimableBytes: 0, survivorDiffersFromPolicy: 0 }, ...overrides
});

/**
 * The page's two scripts in one context, with a stub Data. `data` holds what
 * the stub serves: pages by offset, the stored decisions, and switches to fail.
 */
function reviewTab(data = {}) {
  const store = { pages: { 0: { total: 2, nextOffset: null, groups: [group(1), group(2)] } }, stored: new Map(), stale: [], summary: summaryOf(), fail: {}, ...data };
  const calls = [];
  const values = new Map(Object.entries(data.localStorage || {}));
  const content = { innerHTML: '' };
  const focused = [];
  const root = { innerHTML: '', querySelector(selector) { return { focus() { focused.push(selector); } }; } };
  const listeners = {};
  const fetchStub = async (url, options = {}) => {
    const target = new URL(url, 'http://toolbox.test');
    const route = target.pathname.replace('/api/data-toolbox', '');
    const method = options.method || 'GET';
    const payload = options.body ? JSON.parse(options.body) : undefined;
    calls.push({ method, route, query: target.search, payload });
    if (route === '/janitor/profiles') return body({ profiles: [] });
    if (route === '/janitor/strategy/latest') return body(toolbox.projectJanitorStrategy({ generatedAt: REPORT.generatedAt, status: 'ready_for_review', policy: { duplicateSurvivor: 'canonical_active' }, evidence: { verifiedDuplicateGroups: 2, verifiedDuplicateEvidence: store.reportGroups || [] } }));
    if (route === '/janitor/strategy/latest/groups') {
      if (store.fail.groups) return body(store.fail.groups, 502);
      const named = target.searchParams.get('sha256');
      if (named) return body({ report: REPORT, total: 2, offset: 0, nextOffset: null, groups: (store.named || []).filter((entry) => named.split(',').includes(entry.sha256)) });
      const page = store.pages[target.searchParams.get('offset') || '0'] || { total: 0, nextOffset: null, groups: [] };
      return body({ report: REPORT, offset: Number(target.searchParams.get('offset') || 0), limit: 30, review: target.searchParams.get('review') || 'all', ...page });
    }
    if (route === '/janitor/review-decisions' && method === 'GET') {
      if (store.fail.list) return body(store.fail.list, 502);
      const named = target.searchParams.get('sha256');
      const decisions = named ? named.split(',').filter((id) => store.stored.has(id)).map((id) => ({ sha256: id })) : store.stale;
      return body({ decisions, pagination: { total: decisions.length }, summary: store.summary });
    }
    if (route === '/janitor/review-decisions/batch') {
      if (store.fail.batch) return body(store.fail.batch, 502);
      const saved = [];
      const skipped = [];
      for (const decision of payload.decisions) {
        if (store.stored.has(decision.sha256)) skipped.push(decision.sha256);
        else { store.stored.set(decision.sha256, decision); saved.push(decision.sha256); }
      }
      return body({ mode: payload.mode, saved, skipped });
    }
    const id = route.split('/').pop();
    if (method === 'PUT') {
      if (store.fail.put) return body(store.fail.put, 502);
      store.stored.set(id, payload);
      return body({ decision: { sha256: id, ...payload, survivorPath: payload.survivorPath ?? null, note: payload.note ?? null, decidedAt: '2026-10-08T12:00:00.000Z' }, created: true });
    }
    if (method === 'DELETE') {
      if (store.fail.remove) return body(store.fail.remove, 502);
      store.stored.delete(id);
      return body({ deleted: id });
    }
    return body('unexpected route', 404);
  };
  const context = {
    document: {
      querySelector(selector) {
        if (selector === '#content') return content;
        if (selector === '#janitorReview') return content.innerHTML.includes('id="janitorReview"') ? root : null;
        return {};
      },
      querySelectorAll() { return []; },
      addEventListener(name, callback) { (listeners[name] ||= []).push(callback); }
    },
    // A dialog would hide a failure from the page: the review must never open one.
    window: { addEventListener() {}, location: { hash: '#janitor' }, alert(message) { throw new Error(`alert: ${message}`); } },
    location: { hash: '#janitor' },
    localStorage: {
      getItem(key) { return values.has(key) ? values.get(key) : null; },
      setItem(key, value) { values.set(key, String(value)); },
      removeItem(key) { values.delete(key); }
    },
    fetch: fetchStub, URLSearchParams, console, Date, setTimeout, clearTimeout
  };
  const source = ['janitor-review.js', 'app.js'].map((file) => fs.readFileSync(path.join(publicRoot, file), 'utf8')).join('\n')
    .replace(/\nrender\(\);\s*$/, '\nglobalThis.page = { state, janitor, ui: janitorReviewUi };');
  vm.runInNewContext(source, context);
  const fire = async (name, event) => { for (const callback of listeners[name] || []) await callback(event); };
  return {
    store, calls, root, content, values, focused, ui: context.page.ui, state: context.page.state,
    async open() { context.page.state.tab = 'janitor'; await context.page.janitor(); },
    click(action, id, focus) { return fire('click', { target: { closest: (selector) => (selector === '[data-jr-action]' ? { dataset: { jrAction: action, sha: id, jrFocus: focus } } : null) } }); },
    choose(id, value) { return fire('change', { target: { dataset: { jrKeep: id }, value } }); },
    note(id, value) { return fire('input', { target: { dataset: { jrNote: id }, value } }); },
    filter(checked) { return fire('change', { target: { dataset: { jrFilter: 'undecided' }, checked } }); },
    writes() { return calls.filter((call) => call.method !== 'GET'); },
    draft() { return values.has(DRAFT_KEY) ? JSON.parse(values.get(DRAFT_KEY)) : null; }
  };
}
const DRAFT_KEY = 'agentx.data-toolbox.janitor-review-draft.v1';
const settle = () => new Promise((resolve) => setImmediate(resolve));

test('the review says what a stored decision is for and that nothing here deletes files', async () => {
  const tab = reviewTab();
  await tab.open();
  assert.match(tab.root.innerHTML, /<strong>Nothing here deletes files\.<\/strong> A stored decision records your intent for a later, separately confirmed cleanup/);
  assert.match(tab.root.innerHTML, /Review progress/);
  assert.match(tab.root.innerHTML, /0 of 2 groups shown/);
  assert.match(tab.root.innerHTML, /Groups 1–2 of 2/);
  assert.match(tab.root.innerHTML, /policy would keep · canonical active/);
  assert.deepEqual(tab.writes(), [], 'opening the tab writes nothing');
});

test('a decision is saved to Data as it is made, with the evidence it was made on, and can be undone', async () => {
  const tab = reviewTab();
  await tab.open();
  // Accepting needs a survivor: the message is inline, nothing is sent.
  await tab.click('dedupe', sha(1));
  assert.match(tab.root.innerHTML, /Choose the path to keep before accepting this group for preview/);
  assert.deepEqual(tab.writes(), []);

  await tab.choose(sha(1), B);
  await tab.note(sha(1), '  the copy folder is the organized one  ');
  await tab.click('dedupe', sha(1));
  assert.deepEqual(tab.writes(), [{
    method: 'PUT', route: `/janitor/review-decisions/${sha(1)}`, query: '',
    payload: { decision: 'dedupe', survivorPath: B, note: 'the copy folder is the organized one', source: 'toolbox',
      evidence: { size: 1000, paths: [A, B], reportId: REPORT.id, reportGeneratedAt: REPORT.generatedAt } }
  }]);
  assert.match(tab.root.innerHTML, /Saved to Data\. This records your intent; no file was touched\./);
  assert.match(tab.root.innerHTML, /accepted for preview · keep \/mnt\/datalake\/example\/copy\/a\.bin/);
  // The owner keeps B where the policy would keep A: both are shown.
  assert.match(tab.root.innerHTML, /Your choice and the policy differ/);
  assert.match(tab.root.innerHTML, /1 of 2 groups shown/);
  assert.match(tab.root.innerHTML, /data-jr-action="undo" data-sha="0{63}1"/);
  assert.equal(tab.draft(), null, 'a stored decision is not duplicated in the browser draft');
  assert.equal(tab.focused.at(-1), `[data-jr-focus="dedupe-${sha(1)}"]`, 'keyboard focus returns to the control used');

  await tab.click('keep_all', sha(2));
  assert.deepEqual(tab.writes()[1].payload, { decision: 'keep_all', source: 'toolbox', evidence: { size: 1000, paths: [A, B], reportId: REPORT.id, reportGeneratedAt: REPORT.generatedAt } });

  await tab.click('undo', sha(1), `undo-${sha(1)}`);
  assert.deepEqual(tab.writes()[2], { method: 'DELETE', route: `/janitor/review-decisions/${sha(1)}`, query: '', payload: undefined });
  assert.match(tab.root.innerHTML, /Decision removed\. The group is undecided again; no file was touched\./);
  assert.equal(tab.store.stored.has(sha(1)), false);
  assert.match(tab.root.innerHTML, /1 of 2 groups shown/);
});

test('a save Data refuses is reported inline and the decision goes to the browser draft', async () => {
  const tab = reviewTab({ fail: { put: 'Data service request timed out' } });
  await tab.open();
  await tab.choose(sha(1), A);
  await tab.click('dedupe', sha(1));
  assert.match(tab.root.innerHTML, /Not saved to Data: Data service request timed out\. The decision is kept in this browser&#39;s draft and can be imported later\./);
  const draft = tab.draft();
  assert.equal(draft.authorizesFilesystemMutation, false);
  assert.deepEqual(draft.decisions, [{ size: 1000, paths: [A, B], sha256: sha(1), decision: 'accept_for_preview', keepPath: A, removePaths: [B], reason: 'operator-selected survivor; complete SHA-256 preview required' }]);
  assert.match(tab.root.innerHTML, /accepted for preview · in this browser only/);
  // A failed removal stays inline too.
  tab.store.fail = { remove: 'Data unavailable' };
  tab.store.pages[0].groups[1].review = { decision: 'keep_all', state: 'current', staleReasons: [] };
  await tab.click('undo', sha(2), `undo-${sha(2)}`);
  assert.match(tab.root.innerHTML, /Not removed: Data unavailable/);
});

test('when Data serves neither pages nor decisions the review falls back to the browser draft', async () => {
  const tab = reviewTab({ fail: { groups: 'Data unavailable', list: 'Data unavailable' }, reportGroups: [{ sha256: sha(7), size: 50, count: 2, provenSavingsBytes: 50, files: [{ path: A }, { path: B }] }] });
  await tab.open();
  assert.match(tab.root.innerHTML, /Stored decisions are unavailable/);
  assert.match(tab.root.innerHTML, /Paging is unavailable/);
  assert.match(tab.root.innerHTML, /The first 1 groups of the report are shown instead/);
  await tab.click('keep_all', sha(7));
  assert.deepEqual(tab.writes(), [], 'nothing is sent while Data does not store decisions');
  assert.equal(tab.draft().decisions[0].decision, 'reject_keep_all');
  assert.deepEqual(tab.draft().decisions[0].paths, [A, B]);
  assert.match(tab.root.innerHTML, /Kept in this browser&#39;s draft/);
  // Defer keeps its earlier meaning offline: nothing recorded.
  await tab.click('defer', sha(7));
  assert.equal(tab.draft(), null);
});

function storedDraft(decisions, extra = {}) {
  return { [DRAFT_KEY]: JSON.stringify({ schemaVersion: 1, kind: 'janitor-review-draft', portfolioGeneratedAt: '2026-10-01T07:00:00.000Z', authorizesFilesystemMutation: false, decisions, ...extra }) };
}

test('a browser draft is offered for import, previewed, sent once, and kept as a backup', async () => {
  const legacy = [
    { sha256: sha(21), decision: 'accept_for_preview', keepPath: A, removePaths: [B], reason: 'x' },
    { sha256: sha(22), decision: 'reject_keep_all', keepPath: null, removePaths: [], reason: 'x' },
    { sha256: sha(23), decision: 'reject_keep_all', keepPath: null, removePaths: [], reason: 'x' },
    { sha256: 'hash-from-an-old-test', decision: 'reject_keep_all', keepPath: null, removePaths: [] },
    { sha256: sha(24), decision: 'reject_keep_all', keepPath: null, removePaths: [] }
  ];
  const tab = reviewTab({ localStorage: storedDraft(legacy), named: [group(21), group(22, ['/mnt/media/x/1', '/mnt/media/x/2', '/mnt/media/x/3'], { size: 77 })] });
  tab.store.stored.set(sha(24), { decision: 'defer' });
  await tab.open();
  // Four of the five are not stored; the fifth already is and is not offered.
  assert.match(tab.root.innerHTML, /4 decisions in this browser are not stored in Data/);
  assert.match(tab.root.innerHTML, /data-jr-action="import-preview"[^>]*>Import 4 decisions from this browser/);
  assert.deepEqual(tab.writes(), [], 'nothing is imported without the explicit action');

  await tab.click('import-preview');
  assert.match(tab.root.innerHTML, /Preview: what will be sent to Data/);
  assert.match(tab.root.innerHTML, /2 of 4 can be imported/);
  assert.match(tab.root.innerHTML, /Not in the latest report: its copies and file size are unknown/);
  assert.match(tab.root.innerHTML, /Not a SHA-256 content hash/);
  assert.match(tab.root.innerHTML, /as seen in this browser/);
  assert.match(tab.root.innerHTML, /from the latest report/);
  assert.deepEqual(tab.writes(), [], 'the preview sends nothing');

  await tab.click('import-run');
  assert.deepEqual(tab.writes(), [{
    method: 'POST', route: '/janitor/review-decisions/batch', query: '',
    payload: { mode: 'insert_missing', decisions: [
      { sha256: sha(21), decision: 'dedupe', survivorPath: A, source: 'browser-draft-import', evidence: { size: 1000, paths: [A, B], reportGeneratedAt: '2026-10-01T07:00:00.000Z' } },
      { sha256: sha(22), decision: 'keep_all', source: 'browser-draft-import', evidence: { size: 77, paths: ['/mnt/media/x/1', '/mnt/media/x/2', '/mnt/media/x/3'], reportId: REPORT.id, reportGeneratedAt: REPORT.generatedAt } }
    ] }
  }]);
  assert.match(tab.root.innerHTML, /Import finished\.<\/strong> 2 stored in Data · 0 already stored and left as they were · 2 left in this browser only/);
  // The draft is still there, whole, marked as imported.
  const draft = tab.draft();
  assert.equal(draft.decisions.length, 5);
  assert.match(draft.importedAt, /^\d{4}-\d{2}-\d{2}T/);
  assert.equal(draft.authorizesFilesystemMutation, false);
  assert.match(tab.root.innerHTML, /Imported into Data on .* and kept here as a backup/);
  // What could not be imported is still offered; what was imported is not.
  assert.match(tab.root.innerHTML, /2 decisions in this browser are not stored in Data/);
});

test('a refused batch is retried one decision at a time and each failure is named', async () => {
  const tab = reviewTab({ localStorage: storedDraft([{ sha256: sha(31), decision: 'accept_for_preview', keepPath: A, removePaths: [B], size: 9, paths: [A, B] }]), fail: {} });
  await tab.open();
  await tab.click('import-preview');
  tab.store.fail = { batch: 'decisions[0]: evidence.paths[0] must be under one of /mnt/media, /mnt/datalake' };
  await tab.click('import-run');
  assert.equal(tab.writes().length, 2, 'the batch, then the single decision');
  assert.match(tab.root.innerHTML, /Import finished\.<\/strong> 0 stored in Data · 0 already stored and left as they were · 1 left in this browser only/);
  assert.match(tab.root.innerHTML, /must be under one of \/mnt\/media, \/mnt\/datalake/);
  assert.equal(tab.draft().importedAt, undefined, 'a draft that was not imported is not marked imported');
});

test('no import is offered when the draft is empty, already stored, or Data cannot say', async () => {
  const empty = reviewTab();
  await empty.open();
  assert.doesNotMatch(empty.root.innerHTML, /import-preview/);

  const stored = reviewTab({ localStorage: storedDraft([{ sha256: sha(41), decision: 'reject_keep_all', keepPath: null, removePaths: [] }], { importedAt: '2026-10-07T10:00:00.000Z' }) });
  stored.store.stored.set(sha(41), { decision: 'keep_all' });
  await stored.open();
  assert.doesNotMatch(stored.root.innerHTML, /import-preview/);
  assert.match(stored.root.innerHTML, /Imported into Data on .* and kept here as a backup/);
  assert.match(stored.root.innerHTML, /1 decisions in this browser/);

  const unknown = reviewTab({ localStorage: storedDraft([{ sha256: sha(42), decision: 'reject_keep_all', keepPath: null, removePaths: [] }]), fail: { list: 'Data unavailable' } });
  await unknown.open();
  assert.doesNotMatch(unknown.root.innerHTML, /import-preview/);
  assert.match(unknown.root.innerHTML, /Stored decisions are unavailable/);
});

test('a stale decision is shown with its reason and is never pre-applied to the new shape', async () => {
  const C = '/mnt/media/example/new-copy.bin';
  const staleMark = { decision: 'dedupe', survivorPath: A, note: null, decidedAt: '2026-10-01T10:00:00.000Z', state: 'stale', policySurvivorPath: A, survivorDiffersFromPolicy: false,
    staleReasons: [{ code: 'new_copies', detail: 'Copies appeared that were not there when deciding.', count: 1, paths: [C] }] };
  const tab = reviewTab({
    pages: { 0: { total: 1, nextOffset: null, groups: [group(1, [A, B, C], { review: staleMark })] } },
    summary: summaryOf({ total: 3, byDecision: { keep_all: 1, dedupe: 2, defer: 0 }, current: 1, stale: 2, dedupe: { current: 1, stale: 1, reclaimableBytes: 5368709120, survivorDiffersFromPolicy: 0 } }),
    stale: [{ sha256: sha(1), decision: 'dedupe', decidedAt: '2026-10-01T10:00:00.000Z', staleReasons: staleMark.staleReasons },
      { sha256: sha(9), decision: 'keep_all', decidedAt: null, staleReasons: [{ code: 'group_not_verified', detail: 'This content is no longer a verified duplicate group: fewer than two current copies carry this hash.' }] }]
  });
  await tab.open();
  const html = tab.root.innerHTML;
  assert.match(html, /stale · needs another look/);
  assert.match(html, /This decision needs another look\.<\/strong> It was made on a group that has changed, so it is not applied to the group below/);
  assert.match(html, /Copies appeared that were not there when deciding\./);
  assert.match(html, /your earlier choice/);
  // The earlier survivor is labelled, not selected: no radio is checked.
  assert.doesNotMatch(html, /type="radio"[^>]*checked/);
  assert.match(html, /Needing another look<\/h3>\s*<strong class="root-size warn">2<\/strong>/);
  assert.match(html, /2 stale decisions and why/);
  assert.match(html, /fewer than two current copies carry this hash/);
  assert.match(html, /5\.0 GiB/);
  assert.match(html, /3 of 1 verified groups|Stored in Data<\/span><strong>3 of 1 verified groups/);
  // Accepting again needs a fresh choice on the current copies.
  await tab.click('dedupe', sha(1));
  assert.match(tab.root.innerHTML, /Choose the path to keep before accepting this group for preview/);
  assert.deepEqual(tab.writes(), []);
  // A stale decision outside the page can be removed from the list.
  await tab.click('undo', sha(9), `undo-stale-${sha(9)}`);
  assert.deepEqual(tab.writes().map((call) => `${call.method} ${call.route}`), [`DELETE /janitor/review-decisions/${sha(9)}`]);
});

test('paging walks the report in bounded pages and the undecided filter asks Data', async () => {
  const tab = reviewTab({ pages: {
    0: { total: 90, nextOffset: 30, groups: [group(1)] },
    30: { total: 90, nextOffset: 64, groups: [group(31)] },
    64: { total: 90, nextOffset: null, groups: [group(65)] }
  } });
  await tab.open();
  const pageCalls = () => tab.calls.filter((call) => call.route === '/janitor/strategy/latest/groups').map((call) => call.query);
  assert.deepEqual(pageCalls(), ['?offset=0&limit=30']);
  assert.match(tab.root.innerHTML, /data-jr-action="previous" data-jr-focus="previous" disabled/);
  await tab.click('next');
  await tab.click('next');
  assert.deepEqual(pageCalls(), ['?offset=0&limit=30', '?offset=30&limit=30', '?offset=64&limit=30']);
  assert.match(tab.root.innerHTML, /Groups 65–65 of 90/);
  assert.match(tab.root.innerHTML, /data-jr-action="next" data-jr-focus="next" disabled/);
  await tab.click('next');
  assert.equal(pageCalls().length, 3, 'there is no page after the last');
  await tab.click('previous');
  assert.equal(pageCalls().at(-1), '?offset=30&limit=30');
  assert.match(tab.root.innerHTML, new RegExp(sha(31).slice(0, 16)));

  await tab.filter(true);
  await settle();
  assert.equal(pageCalls().at(-1), '?offset=0&limit=30&review=undecided');
  assert.match(tab.root.innerHTML, /undecided only/);
  assert.match(tab.root.innerHTML, /data-jr-filter="undecided" data-jr-focus="filter" checked/);
});

test('an undecided page with nothing left says so instead of looking broken', async () => {
  const tab = reviewTab({ pages: { 0: { total: 40, nextOffset: null, groups: [] } } });
  await tab.open();
  await tab.filter(true);
  await settle();
  assert.match(tab.root.innerHTML, /Every group from here to the end of the report has a decision/);
  tab.store.pages[0] = { total: 4000, nextOffset: 1000, scanBoundReached: true, groups: [] };
  await tab.filter(true);
  await settle();
  assert.match(tab.root.innerHTML, /No undecided group in the stretch of the report just read\. Use Next to continue\./);
});

test('paths and hashes from the disks are escaped everywhere, and missing values stay unknown', async () => {
  const hostileSha = '"><script>alert(1)</script>';
  const tab = reviewTab({
    pages: { 0: { total: null, nextOffset: null, groups: [
      group(1, [HOSTILE, B], { policySurvivorPath: HOSTILE, review: { decision: 'dedupe', survivorPath: HOSTILE, note: '<b>note</b>', state: 'stale', policySurvivorPath: B, survivorDiffersFromPolicy: true,
        staleReasons: [{ code: '<i>code</i>', detail: '<u>detail</u>', count: 1, paths: [HOSTILE] }] } }),
      { sha256: hostileSha, position: null, size: null, count: null, provenSavingsBytes: null, files: [], filesOmitted: 0, review: null }
    ] } },
    stale: [{ sha256: hostileSha, decision: '<x>', decidedAt: '<y>', staleReasons: [{ detail: '<img src=x>', paths: [HOSTILE] }] }],
    summary: summaryOf({ total: null, stale: 1, dedupe: {} })
  });
  await tab.open();
  const html = tab.root.innerHTML;
  for (const raw of ['<img', '<script', '<b>note', '<u>detail', '<i>code', '<x>', '<y>', 'onerror=alert(1)>/"quoted"']) assert.equal(html.includes(raw), false, `raw ${raw} must not reach the page`);
  assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;\/&quot;quoted&quot; &amp; &#39;single&#39;\.bin/);
  assert.match(html, /value="\/mnt\/media\/&lt;img src=x onerror=alert\(1\)&gt;/);
  assert.match(html, /&quot;&gt;&lt;script&gt;/);
  // Unknown counts and sizes are dashes, never zeros.
  assert.match(html, /— copies · — each/);
  assert.match(html, /Stored in Data<\/span><strong>— of — verified groups/);
  assert.match(html, /<strong class="root-size">—<\/strong>/);
  // The hostile hash cannot be used in a request path unescaped.
  await tab.click('undo', hostileSha, 'undo-stale-x');
  assert.equal(tab.writes()[0].route, `/janitor/review-decisions/${encodeURIComponent(hostileSha)}`);
});

test('a group shown without all its copies cannot be decided', async () => {
  const tab = reviewTab({ pages: { 0: { total: 1, nextOffset: null, groups: [group(1, [A, B], { count: 75, filesOmitted: 73 })] } } });
  await tab.open();
  assert.match(tab.root.innerHTML, /This row omits 73 of 75 copies\. Use the full JSON; no decision is allowed on incomplete evidence\./);
  assert.doesNotMatch(tab.root.innerHTML, /data-jr-action="dedupe"/);
  await tab.click('keep_all', sha(1));
  assert.deepEqual(tab.writes(), []);
});

test('the review styles keep the page usable at phone width', () => {
  const css = fs.readFileSync(path.join(publicRoot, 'janitor-review.css'), 'utf8');
  const html = fs.readFileSync(path.join(publicRoot, 'index.html'), 'utf8');
  assert.match(html, /janitor-review\.css/);
  assert.match(css, /@media \(max-width: 620px\)/);
  assert.match(css, /overflow-wrap: anywhere/);
  assert.match(css, /focus-visible/);
});
