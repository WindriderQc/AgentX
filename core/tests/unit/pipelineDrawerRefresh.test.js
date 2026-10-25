'use strict';
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { readPipelineSource, loadPipelineParts } = require('../helpers/pipelineScripts');
function load() {
  const document = { addEventListener() {}, activeElement: null };
  const context = { document, window: { location: { search: '' } }, URLSearchParams };
  const source = fs.readFileSync(path.resolve(__dirname, '../../public/js/pipeline.js'), 'utf8');
  loadPipelineParts(context);
  vm.runInNewContext(source.replace(/\}\)\(\);\s*$/, 'globalThis.drawerTest = { preserveDrawerDraft, restoreDrawerDraft, latestTeamUpdate };\n})();'), context);
  return { ...context.drawerTest, document };
}
function field(value) {
  return { name: 'answer', value, selectionStart: 2, selectionEnd: 5, closest: () => ({ dataset: { drawerAction: 'reply-resume' } }), focus: jest.fn(), setSelectionRange: jest.fn() };
}
test('background rebuild retains an unsent answer, selection, focus, open details and scroll', () => {
  const api = load(); const original = field('Une réponse non envoyée'); api.document.activeElement = original;
  const before = { scrollTop: 218, querySelectorAll: query => query === 'details' ? [{ open: true }] : [original] };
  const draft = api.preserveDrawerDraft(before);
  const rebuilt = field(''); const detail = { open: false };
  const after = { scrollTop: 0, querySelectorAll: query => query === 'details' ? [detail] : [rebuilt] };
  api.restoreDrawerDraft(after, draft);
  expect(rebuilt.value).toBe(original.value);
  expect(rebuilt.focus).toHaveBeenCalledWith({ preventScroll: true });
  expect(rebuilt.setSelectionRange).toHaveBeenCalledWith(2, 5);
  expect(detail.open).toBe(true); expect(after.scrollTop).toBe(218);
});

test('an intake decision is bound to its reviewed revision while the unsent rationale survives a changed scope', () => {
  const api = load();
  const field = (name, value, scope) => ({ name, value, closest: () => ({ dataset: { intakeDecision: '', revision: '2', scope } }) });
  const body = fields => ({ querySelectorAll: query => query === 'details' ? [] : fields });
  const draft = api.preserveDrawerDraft(body([field('state', 'accepted', 'old-scope'), field('reason', 'Keep this rationale', 'old-scope')]));
  const decision = field('state', '', 'changed-scope'), reason = field('reason', '', 'changed-scope');
  api.restoreDrawerDraft(body([decision, reason]), draft);
  expect(decision.value).toBe('');
  expect(reason.value).toBe('Keep this rationale');
  expect(draft.fields[0].contextBound).toBe(true);
});
test('a relationship operation clears after a scope change while its unsent reference and reason survive', () => {
  const api = load();
  const field = (name, value, scope) => ({ name, value, closest: () => ({ dataset: { workLinks: '', revision: '2', scope } }) });
  const body = fields => ({ querySelectorAll: query => query === 'details' ? [] : fields });
  const draft = api.preserveDrawerDraft(body([field('workOperation', 'add', 'old'), field('workReason', 'Keep the rationale', 'old')]));
  const operation = field('workOperation', '', 'new'), reason = field('workReason', '', 'new');
  api.restoreDrawerDraft(body([operation, reason]), draft);
  expect(operation.value).toBe(''); expect(reason.value).toBe('Keep the rationale');
});
test('a correction disclosure is reopened before its draft field receives focus', () => {
  const api = load(), detail = { open: false }, rebuilt = field('');
  rebuilt.focus.mockImplementation(() => { expect(detail.open).toBe(true); });
  const body = { querySelectorAll: query => query === 'details' ? [detail] : [rebuilt] };
  api.restoreDrawerDraft(body, { details: [{ key: 'detail-0', open: true }], fields: [{ key: 'reply-resume:answer', value: 'Keep this draft', focused: true }], scrollTop: 0 });
  expect(rebuilt.focus).toHaveBeenCalledTimes(1);
});
test('coverage approval survives a refresh of the same report and clears for a new candidate', () => {
  const api = load();
  const checkbox = (context, checked) => ({ name: 'reportScopeComplete', value: 'on', checked,
    closest: () => ({ dataset: { drawerAction: 'confirm-done', reportContext: context } }) });
  const body = el => ({ querySelectorAll: query => query === 'details' ? [] : [el] });
  const draft = api.preserveDrawerDraft(body(checkbox('request-a:sha-a', true)));
  const same = checkbox('request-a:sha-a', false), changed = checkbox('request-b:sha-b', false);
  api.restoreDrawerDraft(body(same), draft);
  api.restoreDrawerDraft(body(changed), draft);
  expect(same.checked).toBe(true);
  expect(changed.checked).toBe(false);
  expect(draft.fields[0].contextBound).toBe(true);
});
test.each(['reportName', 'modelCallLimit', 'resumeReport'])('a new checkpoint does not inherit the old %s selection', name => {
  const api = load();
  const input = (context, value, checked = false) => ({ name, value, checked,
    closest: () => ({ dataset: { drawerAction: 'reply-resume', profileContext: context } }) });
  const body = el => ({ querySelectorAll: query => query === 'details' ? [] : [el] });
  const old = input('parent-a:sha-a', 'old', false), same = input('parent-a:sha-a', 'default', true);
  const fresh = input('parent-b:sha-b', 'new-default', true);
  const draft = api.preserveDrawerDraft(body(old));
  api.restoreDrawerDraft(body(same), draft);
  api.restoreDrawerDraft(body(fresh), draft);
  expect(same.value).toBe('old'); expect(same.checked).toBe(false);
  expect(fresh.value).toBe('new-default'); expect(fresh.checked).toBe(true);
});
test('new attempt evidence does not shift the saved open state of a note disclosure', () => {
  const api = load(), original = field('Keep this note');
  const panel = (key, open) => ({ dataset: { drawerDisclosure: key }, open });
  const before = { querySelectorAll: query => query === 'details'
    ? [panel('metadata', false), panel('other-actions', true), panel('note', true)] : [original] };
  const draft = api.preserveDrawerDraft(before);
  const metadata = panel('metadata', false), attempts = panel('attempts', false), other = panel('other-actions', false), note = panel('note', false);
  const after = { querySelectorAll: query => query === 'details' ? [metadata, attempts, other, note] : [] };
  api.restoreDrawerDraft(after, draft);
  expect(metadata.open).toBe(false);
  expect(attempts.open).toBe(false);
  expect(other.open).toBe(true);
  expect(note.open).toBe(true);
});
test('blocked ticket presents the actual worker question even after an operator note', () => {
  const { latestTeamUpdate } = load();
  expect(latestTeamUpdate({ status: 'blocked', assignee: 'worker', feedback: [
    { by: 'guarded-dispatch', text: 'Guard failed\nWorker question or problem (not verification evidence):\nWhich layout?\n\nThe worker feedback is rejected.' },
    { by: 'operator', text: 'Investigating.' }
  ] })).toBe('Which layout?');
});

test('review leads with the decision to make instead of the raw verifier JSON', () => {
  const { latestTeamUpdate } = load();
  const text = latestTeamUpdate({ status: 'review', feedback: [{ by: 'worker', text: 'Dispatcher independent verification: PASS\n```json\n{"worker_criteria": []}\n```' }] });
  expect(text).toContain('independent verification command passed');
  expect(text).toContain('Review the implementation and its behavior');
  expect(text).not.toContain('worker_criteria');
});
