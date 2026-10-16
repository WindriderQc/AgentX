'use strict';
const activity = require('../../public/js/pipeline-dossier-activity');
const { loadPipelineParts } = require('../helpers/pipelineScripts');
const now = Date.parse('2030-01-02T12:00:00Z');
const claim = { seq: 5, kind: 'claimed', at: '2030-01-02T11:20:00Z' };
const task = { pipelineId: '0042', status: 'in_progress', assignee: 'coding-team',
  createdAt: '2030-01-01T17:00:00Z', transitions: [
    { seq: 2, kind: 'claimed', at: '2030-01-01T18:00:00Z' }, claim
  ], feedback: [
    { by: 'coding-team', at: '2030-01-01T18:10:00Z', text: 'Previous run failed.' },
    { by: 'operator', at: '2030-01-02T11:19:59Z', text: 'Long operator instructions with /private/path.' }
  ] };

test('heartbeat and operator instructions never become a current worker update', () => {
  const view = activity.read({ ...task, heartbeatAt: new Date(now).toISOString(), updatedAt: new Date(now).toISOString() }, now);
  expect(view.workerEntry).toBeUndefined();
  expect(view.instruction.text).toContain('operator instructions');
  expect(view).toMatchObject({ earlierClaims: 1, elapsed: '40 min' });
  const html = activity.markup(task, view, value => value || 'Unknown');
  expect(html).toContain('40 min elapsed');
  expect(html).toContain('1 earlier worker claim recorded');
  expect(html).not.toContain('Previous run failed');
  expect(html).not.toContain('/private/path');
});

test('the current worker message survives a later operator note, unordered history and future messages', () => {
  const message = { by: 'coding-team', at: '2030-01-02T11:30:00Z', text: 'Saved the first group.' };
  const view = activity.read({ ...task, transitions: task.transitions.slice().reverse(), feedback: [
    message, ...task.feedback, { by: 'operator', at: '2030-01-02T11:40:00Z', text: 'Please continue.' },
    { by: 'coding-team', at: '2030-01-03T12:00:00Z', text: 'Future message' }
  ] }, now);
  expect(view.workerEntry).toEqual(message);
  expect(view.instruction.text).toBe('Please continue.');
});

test('a stopped run has a fixed duration rather than accumulating blocked time', () => {
  const stopped = { ...task, status: 'blocked', transitions: [...task.transitions,
    { seq: 6, from: 'in_progress', to: 'blocked', at: '2030-01-02T11:35:00Z' }] };
  expect(activity.read(stopped, now).elapsed).toBe('15 min');
  expect(activity.read(stopped, now + 3600000).elapsed).toBe('15 min');
  expect(activity.read({ ...stopped, transitions: [claim] }, now).elapsed).toBeNull();
});

test('missing, invalid and future claim times retain unknown timing and current progress', () => {
  for (const transitions of [[], [{ ...claim, at: 'bad' }], [{ ...claim, at: '2031-01-01' }]]) {
    const view = activity.read({ ...task, transitions }, now);
    expect(view.claim).toBeUndefined(); expect(view.elapsed).toBeNull();
    expect(view.workerEntry).toBeNull();
    expect(activity.markup(task, view, String)).toContain('Start time not recorded');
  }
});

test('inspection opens the diagnosis and its parent, then focuses its summary', () => {
  const summary = { focus: jest.fn() };
  const diagnosis = { open: false, querySelector: () => summary, scrollIntoView: jest.fn() };
  const technical = { open: false, querySelector: () => diagnosis };
  activity.inspect({ querySelector: () => technical });
  expect(technical.open).toBe(true); expect(diagnosis.open).toBe(true);
  expect(summary.focus).toHaveBeenCalled();
});

function render(overrides) {
  const body = { innerHTML: '' }, document = { addEventListener() {}, getElementById: () => null };
  const context = { window: {}, document, Date: class extends Date { static now() { return now; } } };
  loadPipelineParts(context);
  const esc = value => String(value || '').replaceAll('<', '&lt;');
  context.window.PipelineDeliverables = { markup: () => '<section>Registered task files</section>' };
  const drawer = context.window.PipelineDrawer.create({ drawerEls: () => ({ body }), state: { drawer: {} },
    reviewContext: t => ({ code: t.status === 'blocked' ? 'inspect_blocker' : 'observe_progress', actor: 'worker' }),
    readStorage: () => '', escapeHtml: esc, formatDate: value => value || 'Unknown', statusBadge: () => '', priorityChip: () => '', riskChip: () => '',
    latestTeamUpdate: t => t.feedback.at(-1).text, relativeTime: () => 'just now', renderAttemptDossier: () => '', metaRow: () => '', renderSupersedePreview: () => '' });
  drawer.renderDrawer({ ...task, ...overrides });
  return body.innerHTML;
}
test('the actual dossier leads with absent worker progress and keeps long instructions collapsed', () => {
  const html = render();
  expect(html).toContain('No progress update for this run');
  expect(html).toContain('Inspect activity and history');
  expect(html).not.toContain('Nothing to decide');
  expect(html).not.toContain('The worker owns the next step');
  expect(html.indexOf('Latest operator instructions')).toBeGreaterThan(html.indexOf('pipeline-drawer-next'));
  expect(html).toContain('data-drawer-section="instructions"><summary>');
});
test('a current worker update is rendered instead of later operator instructions', () => {
  const html = render({ feedback: [...task.feedback,
    { by: 'coding-team', at: '2030-01-02T11:30:00Z', text: 'Current worker update' },
    { by: 'operator', at: '2030-01-02T11:40:00Z', text: 'Later operator instruction' }] });
  expect(html).toContain('Latest worker update');
  expect(html).toContain('Current worker update</div>');
  expect(html.indexOf('Later operator instruction')).toBeGreaterThan(html.indexOf('Latest operator instructions'));
  expect(html).not.toContain('Previous run failed.</div>');
});
test('blocked dossiers keep files visible before the technical disclosures', () => {
  const html = render({ status: 'blocked' });
  expect(html.indexOf('Registered task files')).toBeLessThan(html.indexOf('Technical details and history'));
});
