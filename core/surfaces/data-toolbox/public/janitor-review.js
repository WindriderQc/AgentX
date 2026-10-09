'use strict';

// The duplicate review of the Toolbox Janitor tab. Loaded before app.js, whose
// helpers (state, api, e, array, number, bytes, date, label, heading and the
// browser-draft functions) it uses when called.
//
// The owner's decision about a duplicate group is saved to Data as it is made:
// a record of INTENT for a later, separately confirmed cleanup. Nothing here
// previews, approves or deletes a file; the three writes of this file store,
// import or remove such a record. When Data cannot be reached the decision
// stays in this browser's draft, as before, and can be imported later.
// Paths come from the disks: every one is escaped before it is shown.

const JR_PAGE_SIZE = 30;
const JR_STALE_SHOWN = 50;
const JR_IMPORT_CHECK_MAX = 500;
const JR_IMPORT_BATCH = 20;
const JR_IMPORT_BATCH_BYTES = 60000;
const JR_PREVIEW_ROWS = 40;
const JR_NOTE_MAX = 500;
const JR_PATHS_MAX = 500;
const JR_SHA = /^[0-9a-f]{64}$/;
const JR_LABELS = Object.freeze({ dedupe: 'accepted for preview', keep_all: 'deletion rejected · keep all', defer: 'deferred' });
const JR_DRAFT_KINDS = Object.freeze({ accept_for_preview: 'dedupe', reject_keep_all: 'keep_all' });

const janitorReviewUi = {
  seq: 0, report: null, page: null, offset: 0, history: [], undecidedOnly: false, busy: false,
  // null: not asked yet; true: Data serves stored decisions; false: it did not.
  stored: null, storeError: '', summary: null, stale: [],
  status: {}, selected: {}, notes: {}, open: {},
  pending: [], pendingUnchecked: 0, importPreview: null, importResult: null, importBusy: false, importError: ''
};

const jrSettled = (promise) => promise.then((data) => ({ data }), (error) => ({ error: error.message || String(error) }));
const jrRoot = () => document.querySelector('#janitorReview');
const jrShort = (sha) => `${String(sha || '—').slice(0, 16)}${String(sha || '').length > 16 ? '…' : ''}`;
const jrDraft = () => Object.values(state.janitorReview || {});
// An error message as a sentence, whatever punctuation it came with.
const jrSentence = (message) => `${String(message || 'Data did not answer').replace(/[.\s]+$/, '')}.`;

/** The placeholder app.js puts in the Janitor tab; janitorReviewMount fills it. */
function janitorReviewSection() {
  return '<section id="janitorReview" class="jr"><div class="loading"><span></span>Loading the duplicate review…</div></section>';
}

/** Load the first page of groups and the stored decisions, then render. */
async function janitorReviewMount(report) {
  const ui = janitorReviewUi;
  ui.report = report || {};
  ui.importPreview = null;
  ui.status = {};
  await jrLoad();
}

function jrFallbackPage(error) {
  const report = janitorReviewUi.report;
  return {
    fallback: true,
    error,
    report: { id: null, generatedAt: report.generatedAt || null, duplicateSurvivorRule: report.policy?.duplicateSurvivor || null },
    total: report.duplicatesTotal,
    offset: 0,
    nextOffset: null,
    groups: array(report.duplicates).map((group) => ({ ...group, position: null, policySurvivorPath: null, review: null }))
  };
}

async function jrLoad(focus) {
  const ui = janitorReviewUi;
  const seq = ++ui.seq;
  ui.busy = true;
  jrRender();
  const query = `offset=${ui.offset}&limit=${JR_PAGE_SIZE}${ui.undecidedOnly ? '&review=undecided' : ''}`;
  const [page, list] = await Promise.all([
    jrSettled(api(`/janitor/strategy/latest/groups?${query}`)),
    jrSettled(api(`/janitor/review-decisions?state=stale&limit=${JR_STALE_SHOWN}`))
  ]);
  if (seq !== ui.seq) return;
  ui.page = page.error ? jrFallbackPage(page.error) : page.data;
  jrApplyList(list);
  await jrCheckDraft();
  if (seq !== ui.seq) return;
  ui.busy = false;
  jrRender(focus);
}

function jrApplyList(list) {
  const ui = janitorReviewUi;
  ui.stored = !list.error;
  ui.storeError = list.error || '';
  ui.summary = list.error ? null : (list.data.summary || null);
  ui.stale = list.error ? [] : array(list.data.decisions);
}

async function jrRefreshSummary() {
  jrApplyList(await jrSettled(api(`/janitor/review-decisions?state=stale&limit=${JR_STALE_SHOWN}`)));
}

/** Which decisions of this browser's draft are not stored in Data. */
async function jrCheckDraft() {
  const ui = janitorReviewUi;
  const draft = jrDraft();
  ui.pending = [];
  ui.pendingUnchecked = 0;
  if (!draft.length || !ui.stored) return;
  const hashed = draft.filter((entry) => JR_SHA.test(entry.sha256));
  const checked = hashed.slice(0, JR_IMPORT_CHECK_MAX);
  ui.pendingUnchecked = hashed.length - checked.length;
  const stored = new Set();
  for (let index = 0; index < checked.length; index += 100) {
    const shas = checked.slice(index, index + 100).map((entry) => entry.sha256);
    const result = await jrSettled(api(`/janitor/review-decisions?limit=100&sha256=${shas.join(',')}`));
    // Unknown is not "absent": without an answer nothing is offered for import.
    if (result.error) { ui.pending = []; return; }
    for (const decision of array(result.data.decisions)) stored.add(decision.sha256);
  }
  ui.pending = draft.filter((entry) => !JR_SHA.test(entry.sha256) || (checked.includes(entry) && !stored.has(entry.sha256)));
}

// ------------------------------------------------------------------ rendering

function jrGroup(sha) {
  return array(janitorReviewUi.page?.groups).find((group) => group.sha256 === sha) || null;
}

function jrComplete(group) {
  const paths = array(group.files).map((file) => file.path).filter(Boolean);
  return !group.filesOmitted && Number(group.count) === paths.length && paths.length > 1 && paths.length <= JR_PATHS_MAX;
}

function jrStatusLine(sha) {
  const status = janitorReviewUi.status[sha];
  if (!status) return '';
  const tone = status.kind === 'failed' ? 'warning' : status.kind === 'saved' ? 'success' : '';
  return `<p class="jr-status notice ${tone}" role="status">${e(status.message)}</p>`;
}

function jrReasons(reasons) {
  return array(reasons).map((reason) => `<li>${e(reason.detail || label(reason.code))}${reason.count ? ` <span class="muted">(${number(reason.count)})</span>` : ''}${array(reason.paths).map((path) => `<code>${e(path)}</code>`).join('')}</li>`).join('');
}

function jrGroupCard(group) {
  const ui = janitorReviewUi;
  const sha = group.sha256;
  const review = group.review;
  const draft = !review ? state.janitorReview?.[sha] : null;
  const stale = review?.state === 'stale';
  const complete = jrComplete(group);
  const files = array(group.files);
  // A stale decision was taken on another shape: its survivor is shown, never pre-selected.
  const chosen = ui.selected[sha] ?? (review && !stale ? review.survivorPath : draft?.keepPath) ?? '';
  const decisionText = review
    ? `${JR_LABELS[review.decision] || '—'}${review.decision === 'dedupe' ? ` · keep ${review.survivorPath || '—'}` : ''}`
    : draft ? `${JR_LABELS[JR_DRAFT_KINDS[draft.decision]] || '—'} · in this browser only` : 'undecided';
  const pillTone = review ? (review.decision === 'dedupe' && !stale ? 'good' : 'warn') : draft ? 'warn' : '';
  const choices = complete ? files.map((file) => {
    const tags = [
      group.policySurvivorPath && group.policySurvivorPath === file.path ? `<span class="pill">policy would keep · ${e(label(ui.page?.report?.duplicateSurvivorRule))}</span>` : '',
      review?.survivorPath === file.path ? `<span class="pill ${stale ? 'warn' : 'good'}">${stale ? 'your earlier choice' : 'your choice'}</span>` : ''
    ].join('');
    return `<label class="review-choice"><input type="radio" name="keep-${e(sha)}" value="${e(file.path)}" data-jr-keep="${e(sha)}" ${chosen === file.path ? 'checked' : ''}><span><strong>Keep this path</strong><code>${e(file.path)}</code><small>${e(label(file.storageRole))} ${tags}</small></span></label>`;
  }).join('') : '';
  // Shown for a decision that still fits its group; a stale one is not compared.
  const differs = review?.survivorDiffersFromPolicy && !stale
    ? `<div class="notice"><strong>Your choice and the policy differ.</strong> Both are shown; neither replaces the other.<dl class="jr-pair"><dt>You keep</dt><dd><code>${e(review.survivorPath)}</code></dd><dt>The policy rule ${e(label(ui.page?.report?.duplicateSurvivorRule))} would keep</dt><dd><code>${e(review.policySurvivorPath)}</code></dd></dl></div>` : '';
  const staleNote = stale
    ? `<div class="notice warning"><strong>This decision needs another look.</strong> It was made on a group that has changed, so it is not applied to the group below. Decide again to record it on the current copies, or undo it.<ul class="jr-reasons">${jrReasons(review.staleReasons)}</ul>${review.survivorPath && !files.some((file) => file.path === review.survivorPath) ? `<p>Earlier choice: <code>${e(review.survivorPath)}</code></p>` : ''}</div>` : '';
  const note = ui.notes[sha] ?? review?.note ?? '';
  const controls = complete
    ? `<label class="jr-note"><span>Note (optional)</span><input type="text" maxlength="${JR_NOTE_MAX}" value="${e(note)}" data-jr-note="${e(sha)}" placeholder="Why this choice"></label>
      <div class="review-actions">
        <button class="button" type="button" data-jr-action="dedupe" data-sha="${e(sha)}" data-jr-focus="dedupe-${e(sha)}">Accept for preview</button>
        <button class="button" type="button" data-jr-action="keep_all" data-sha="${e(sha)}" data-jr-focus="keep_all-${e(sha)}">Reject deletion</button>
        <button class="button" type="button" data-jr-action="defer" data-sha="${e(sha)}" data-jr-focus="defer-${e(sha)}">Defer</button>
        ${review || draft ? `<button class="button" type="button" data-jr-action="undo" data-sha="${e(sha)}" data-jr-focus="undo-${e(sha)}">Undo</button>` : ''}
      </div>`
    : `<div class="notice warning">This row omits ${number(group.filesOmitted)} of ${number(group.count)} copies. Use the full JSON; no decision is allowed on incomplete evidence.</div>${review ? `<div class="review-actions"><button class="button" type="button" data-jr-action="undo" data-sha="${e(sha)}" data-jr-focus="undo-${e(sha)}">Undo</button></div>` : ''}`;
  const saved = review ? `<p class="muted jr-saved">Saved in Data${review.decidedAt ? ` · ${date(review.decidedAt)}` : ''}${review.note ? ` · note: ${e(review.note)}` : ''}</p>` : '';
  return `<article class="jr-group${stale ? ' stale' : ''}" data-jr-group="${e(sha)}">
    <details data-jr-details="${e(sha)}" ${ui.open[sha] ? 'open' : ''}>
      <summary data-jr-focus="summary-${e(sha)}"><span class="mono">${e(jrShort(sha))}</span><span class="jr-facts"><span class="jr-name">${e(String(files[0]?.path || '—').split('/').pop() || '—')}</span>${number(group.count)} copies · ${bytes(group.size)} each · <strong class="good">${bytes(group.provenSavingsBytes)}</strong> duplicated</span><span class="jr-pills"><span class="pill ${pillTone}">${e(decisionText)}</span>${stale ? '<span class="pill warn">stale · needs another look</span>' : ''}</span></summary>
      ${staleNote}${differs}
      <div class="review-choices">${choices}</div>
      ${controls}${saved}${jrStatusLine(sha)}
    </details>
  </article>`;
}

function jrProgress() {
  const ui = janitorReviewUi;
  const groups = array(ui.page?.groups);
  const decidedHere = groups.filter((group) => group.review).length;
  if (!ui.stored) {
    return `<div class="notice warning" role="status"><strong>Stored decisions are unavailable.</strong> ${e(jrSentence(ui.storeError))} Decisions made now stay in this browser's draft, as before, and can be imported once Data answers again.</div>`;
  }
  const summary = ui.summary || {};
  const by = summary.byDecision || {};
  const staleRows = ui.stale.map((decision) => `<li><span class="mono">${e(jrShort(decision.sha256))}</span> <span class="pill warn">${e(JR_LABELS[decision.decision] || '—')}</span> <span class="muted">decided ${date(decision.decidedAt)}</span><ul class="jr-reasons">${jrReasons(decision.staleReasons)}</ul><button class="button" type="button" data-jr-action="undo" data-sha="${e(decision.sha256)}" data-jr-focus="undo-stale-${e(decision.sha256)}">Remove this decision</button>${jrStatusLine(`stale-${decision.sha256}`)}</li>`).join('');
  return `<div class="grid jr-progress">
      <article class="card"><h3>Decided</h3>
        <div class="metric-row"><span>On this page</span><strong>${number(decidedHere)} of ${number(groups.length)} groups shown</strong></div>
        <div class="metric-row"><span>Stored in Data</span><strong>${number(summary.total)} of ${number(ui.page?.total)} verified groups</strong></div>
      </article>
      <article class="card"><h3>By decision</h3>
        <div class="metric-row"><span>Accepted for preview</span><strong>${number(by.dedupe)}</strong></div>
        <div class="metric-row"><span>Deletion rejected</span><strong>${number(by.keep_all)}</strong></div>
        <div class="metric-row"><span>Deferred</span><strong>${number(by.defer)}</strong></div>
      </article>
      <article class="card"><h3>Space the accepted groups represent</h3>
        <strong class="root-size">${bytes(summary.dedupe?.reclaimableBytes)}</strong>
        <span class="metric-label">duplicate copies in ${number(summary.dedupe?.current)} accepted groups that still match · not freed, nothing is deleted here</span>
      </article>
      <article class="card"><h3>Needing another look</h3>
        <strong class="root-size ${Number(summary.stale) ? 'warn' : ''}">${number(summary.stale)}</strong>
        <span class="metric-label">stale decisions: the group changed since the decision</span>
      </article>
    </div>
    ${summary.truncated ? `<div class="notice">Only the ${number(summary.evaluated)} most recent decisions are checked against the file index; the counts by decision cover all ${number(summary.total)}.</div>` : ''}
    ${ui.stale.length ? `<details class="jr-stale" ${ui.open.stale ? 'open' : ''} data-jr-details="stale"><summary data-jr-focus="summary-stale">${number(summary.stale)} stale ${Number(summary.stale) === 1 ? 'decision' : 'decisions'} and why${Number(summary.stale) > ui.stale.length ? ` · first ${number(ui.stale.length)} shown` : ''}</summary><ul class="jr-stale-list">${staleRows}</ul></details>` : ''}`;
}

function jrDraftBlock() {
  const ui = janitorReviewUi;
  const draft = jrDraft();
  const accepted = draft.filter((entry) => entry.decision === 'accept_for_preview').length;
  const rejected = draft.filter((entry) => entry.decision === 'reject_keep_all').length;
  const imported = state.janitorReviewImportedAt;
  const buttons = `<div class="actions"><button class="button" data-action="janitor-copy-review" ${draft.length ? '' : 'disabled'}>Copy draft</button><button class="button" data-action="janitor-download-review" ${draft.length ? '' : 'disabled'}>Download draft</button><button class="button" data-action="janitor-clear-review" ${draft.length ? '' : 'disabled'}>Clear</button></div>`;
  const groups = array(ui.page?.groups);
  const outside = draft.filter((entry) => !groups.some((group) => group.sha256 === entry.sha256)).length;
  return `${heading('Browser draft', 'The fallback when Data cannot be reached, and the backup of what was imported. Its decisions are keyed by SHA-256 and saved in this browser across refreshes, tab changes, and portfolio regenerations until you clear them; copy or download the draft to keep a file copy.', buttons)}
    <div class="notice"><strong>${number(accepted)} accepted for preview · ${number(rejected)} rejected · ${number(draft.length)} decisions in this browser.</strong> This draft authorizes no filesystem mutation. “Accept” means re-hash in a later preview, never delete.${imported && draft.length ? ` Imported into Data on ${date(imported)} and kept here as a backup.` : ''}</div>
    ${state.janitorReviewDraftFrom && state.janitorReviewDraftFrom !== ui.report.generatedAt && outside ? `<div class="notice">${number(outside)} of these decisions refer to groups outside the rows shown (draft last captured against the report generated ${date(state.janitorReviewDraftFrom)}). They are kept — content hashes do not change between reports — and stay in the copied/downloaded draft.</div>` : ''}`;
}

function jrImportBlock() {
  const ui = janitorReviewUi;
  const result = ui.importResult
    ? `<div class="notice ${ui.importResult.failed.length ? 'warning' : 'success'}" role="status"><strong>Import finished.</strong> ${number(ui.importResult.saved)} stored in Data · ${number(ui.importResult.skipped)} already stored and left as they were · ${number(ui.importResult.left)} left in this browser only.${ui.importResult.failed.length ? `<ul class="jr-reasons">${ui.importResult.failed.slice(0, 5).map((failure) => `<li><span class="mono">${e(jrShort(failure.sha256))}</span> ${e(failure.message)}</li>`).join('')}</ul>` : ''} The browser draft is kept as a backup; nothing was deleted.</div>` : '';
  if (!ui.pending.length) return result;
  if (!ui.importPreview) {
    return `${result}<div class="notice jr-import"><strong>${number(ui.pending.length)} ${ui.pending.length === 1 ? 'decision' : 'decisions'} in this browser ${ui.pending.length === 1 ? 'is' : 'are'} not stored in Data.</strong> Importing records them as intent; it deletes nothing and never replaces a decision already stored.${ui.pendingUnchecked ? ` ${number(ui.pendingUnchecked)} more were not checked (the first ${number(JR_IMPORT_CHECK_MAX)} are).` : ''}
      <div class="review-actions"><button class="button" type="button" data-jr-action="import-preview" data-jr-focus="import-preview" ${ui.importBusy ? 'disabled' : ''}>Import ${number(ui.pending.length)} ${ui.pending.length === 1 ? 'decision' : 'decisions'} from this browser</button></div>
      ${ui.importError ? `<p class="jr-status notice warning" role="status">${e(ui.importError)}</p>` : ''}</div>`;
  }
  const rows = ui.importPreview.rows;
  const ready = rows.filter((row) => !row.problem);
  const shown = rows.slice(0, JR_PREVIEW_ROWS);
  return `${result}<div class="notice jr-import"><strong>Preview: what will be sent to Data.</strong> ${number(ready.length)} of ${number(rows.length)} can be imported. Each is stored as a record of intent, with the copies it was decided on; a decision already stored for the same group is left as it is.
      <div class="table-wrap"><table><thead><tr><th>Group</th><th>Stored as</th><th>Copy to keep</th><th>Copies</th><th>File size</th><th>Result</th></tr></thead><tbody>
      ${shown.map((row) => `<tr><td class="mono">${e(jrShort(row.sha256))}</td><td>${e(JR_LABELS[row.decision] || '—')}</td><td>${row.survivorPath ? `<code>${e(row.survivorPath)}</code>` : '—'}</td><td>${row.paths ? `${number(row.paths.length)}<div class="muted">${e(row.pathsFrom === 'draft' ? 'as seen in this browser' : 'from the latest report')}</div>` : '—'}</td><td>${bytes(row.size)}</td><td>${row.problem ? `<span class="pill warn">stays in this browser</span><div class="muted">${e(row.problem)}</div>` : '<span class="pill good">will be imported</span>'}</td></tr>`).join('')}
      </tbody></table></div>
      ${rows.length > shown.length ? `<p class="muted">${number(rows.length - shown.length)} more rows are not shown; they are handled the same way.</p>` : ''}
      <div class="review-actions"><button class="button" type="button" data-jr-action="import-run" data-jr-focus="import-run" ${ready.length && !ui.importBusy ? '' : 'disabled'}>${ui.importBusy ? 'Importing…' : `Import ${number(ready.length)} ${ready.length === 1 ? 'decision' : 'decisions'}`}</button><button class="button" type="button" data-jr-action="import-cancel" ${ui.importBusy ? 'disabled' : ''}>Cancel</button></div>
      ${ui.importError ? `<p class="jr-status notice warning" role="status">${e(ui.importError)}</p>` : ''}</div>`;
}

function jrPager() {
  const ui = janitorReviewUi;
  const page = ui.page || {};
  const groups = array(page.groups);
  const positions = groups.map((group) => group.position).filter((value) => Number.isFinite(value));
  const range = positions.length ? `Groups ${number(positions[0] + 1)}–${number(positions[positions.length - 1] + 1)} of ${number(page.total)}` : `${number(groups.length)} of ${number(page.total)} groups`;
  return `<nav class="jr-pager" aria-label="Verified duplicate groups, by page">
      <button class="button" type="button" data-jr-action="previous" data-jr-focus="previous" ${ui.history.length && !ui.busy ? '' : 'disabled'}>Previous</button>
      <span role="status">${e(range)}${ui.undecidedOnly ? ' · undecided only' : ''}${ui.busy ? ' · loading…' : ''}</span>
      <button class="button" type="button" data-jr-action="next" data-jr-focus="next" ${Number.isFinite(page.nextOffset) && page.nextOffset !== null && !ui.busy ? '' : 'disabled'}>Next</button>
    </nav>`;
}

function jrRender(focus) {
  const root = jrRoot();
  if (!root || state.tab !== 'janitor') return;
  const ui = janitorReviewUi;
  if (!ui.page) {
    root.innerHTML = '<div class="loading"><span></span>Loading the duplicate review…</div>';
    return;
  }
  const page = ui.page;
  const groups = array(page.groups);
  const filter = `<label class="jr-filter"><input type="checkbox" data-jr-filter="undecided" data-jr-focus="filter" ${ui.undecidedOnly ? 'checked' : ''} ${page.fallback ? 'disabled' : ''}><span>Show only undecided groups</span></label>`;
  const empty = ui.undecidedOnly
    ? (page.scanBoundReached ? 'No undecided group in the stretch of the report just read. Use Next to continue.' : 'Every group from here to the end of the report has a decision.')
    : 'No verified duplicate groups are present in this report.';
  root.innerHTML = `${heading('Duplicate review', 'Choose one survivor path per complete group, then accept it for a future preview, reject deletion, or defer. Each decision is saved to Data as you make it.')}
    <div class="notice"><strong>Nothing here deletes files.</strong> A stored decision records your intent for a later, separately confirmed cleanup: that cleanup still needs a current profile run, a fresh SHA-256 preview and its own typed confirmations, none of which this page can send.</div>
    ${heading('Review progress', 'What is decided, what the accepted groups represent, and which decisions the disks have moved away from.')}
    ${jrProgress()}
    ${jrImportBlock()}
    ${heading('Verified duplicate groups', `${number(page.total)} SHA-256 groups in the report generated ${date(page.report?.generatedAt)}, ${number(JR_PAGE_SIZE)} per page, in the report's order.`, filter)}
    ${page.fallback ? `<div class="notice warning" role="status"><strong>Paging is unavailable.</strong> ${e(jrSentence(page.error))} The first ${number(groups.length)} groups of the report are shown instead.</div>` : ''}
    ${jrPager()}
    <div class="jr-groups">${groups.length ? groups.map(jrGroupCard).join('') : `<div class="empty">${e(empty)}</div>`}</div>
    ${groups.length > 6 ? jrPager() : ''}
    ${jrDraftBlock()}`;
  if (focus && typeof root.querySelector === 'function') {
    const target = root.querySelector(`[data-jr-focus="${focus}"]`);
    if (target && typeof target.focus === 'function') target.focus();
  }
}

// -------------------------------------------------------------------- actions

function jrMark(decision, group) {
  const fromPolicy = group.policySurvivorPath || null;
  return {
    decision: decision.decision,
    survivorPath: decision.survivorPath ?? null,
    note: decision.note ?? null,
    decidedAt: decision.decidedAt || null,
    // Just decided on the copies shown: it fits them by construction.
    state: 'current',
    staleReasons: [],
    policySurvivorPath: fromPolicy,
    survivorDiffersFromPolicy: decision.decision === 'dedupe' && !!fromPolicy && fromPolicy !== decision.survivorPath
  };
}

function jrKeepInDraft(group, kind, survivor) {
  const sha = group.sha256;
  const paths = array(group.files).map((file) => file.path).filter(Boolean);
  if (kind === 'defer') delete state.janitorReview[sha];
  else {
    state.janitorReview[sha] = kind === 'keep_all'
      ? { sha256: sha, decision: 'reject_keep_all', keepPath: null, removePaths: [], reason: 'operator rejected deletion proposal; keep every member', size: group.size, paths }
      : { sha256: sha, decision: 'accept_for_preview', keepPath: survivor, removePaths: paths.filter((path) => path !== survivor), reason: 'operator-selected survivor; complete SHA-256 preview required', size: group.size, paths };
  }
  return persistJanitorReviewDraft();
}

function jrForgetDraft(sha) {
  if (!state.janitorReview?.[sha]) return;
  delete state.janitorReview[sha];
  persistJanitorReviewDraft();
}

async function jrDecide(sha, kind) {
  const ui = janitorReviewUi;
  const group = jrGroup(sha);
  if (!group || !jrComplete(group)) return;
  ui.open[sha] = true;
  const paths = array(group.files).map((file) => file.path);
  const review = group.review;
  const survivor = ui.selected[sha] ?? (review && review.state !== 'stale' ? review.survivorPath : state.janitorReview?.[sha]?.keepPath) ?? '';
  if (kind === 'dedupe' && !paths.includes(survivor)) {
    ui.status[sha] = { kind: 'failed', message: 'Choose the path to keep before accepting this group for preview.' };
    return jrRender(`dedupe-${sha}`);
  }
  const note = String(ui.notes[sha] ?? review?.note ?? '').trim().slice(0, JR_NOTE_MAX);
  if (!ui.stored) {
    const kept = jrKeepInDraft(group, kind, survivor);
    ui.status[sha] = kept
      ? { kind: 'draft', message: kind === 'defer' ? 'Deferred: nothing is recorded for this group in this browser.' : 'Kept in this browser\'s draft: Data is not storing decisions right now.' }
      : { kind: 'failed', message: 'This browser refused to store the draft; the decision is held only until the page is closed.' };
    return jrRender(`${kind}-${sha}`);
  }
  ui.status[sha] = { kind: 'saving', message: 'Saving to Data…' };
  jrRender(`${kind}-${sha}`);
  const payload = {
    decision: kind,
    ...(kind === 'dedupe' ? { survivorPath: survivor } : {}),
    ...(note ? { note } : {}),
    source: 'toolbox',
    evidence: {
      size: group.size,
      paths,
      ...(ui.page.report?.id ? { reportId: ui.page.report.id } : {}),
      ...(ui.page.report?.generatedAt ? { reportGeneratedAt: ui.page.report.generatedAt } : {})
    }
  };
  try {
    const saved = await api(`/janitor/review-decisions/${encodeURIComponent(sha)}`, { method: 'PUT', payload });
    group.review = jrMark(saved.decision || payload, group);
    delete ui.selected[sha];
    delete ui.notes[sha];
    jrForgetDraft(sha);
    ui.status[sha] = { kind: 'saved', message: 'Saved to Data. This records your intent; no file was touched.' };
    await jrRefreshSummary();
  } catch (error) {
    // Data did not take it: the choice is not lost, it goes to the browser draft.
    const kept = jrKeepInDraft(group, kind, survivor);
    ui.status[sha] = { kind: 'failed', message: `Not saved to Data: ${jrSentence(error.message)}${kept && kind !== 'defer' ? ' The decision is kept in this browser\'s draft and can be imported later.' : ''}` };
  }
  jrRender(`${kind}-${sha}`);
}

async function jrUndo(sha, fromStaleList) {
  const ui = janitorReviewUi;
  const key = fromStaleList ? `stale-${sha}` : sha;
  const group = jrGroup(sha);
  if (group) ui.open[sha] = true;
  if (group && !group.review && !fromStaleList) {
    // Only a browser-draft entry exists for this group.
    jrForgetDraft(sha);
    ui.status[sha] = { kind: 'saved', message: 'Removed from this browser\'s draft.' };
    return jrRender(`summary-${sha}`);
  }
  ui.status[key] = { kind: 'saving', message: 'Removing the stored decision…' };
  jrRender();
  try {
    await api(`/janitor/review-decisions/${encodeURIComponent(sha)}`, { method: 'DELETE' });
    if (group) group.review = null;
    jrForgetDraft(sha);
    delete ui.status[key];
    if (group) ui.status[sha] = { kind: 'saved', message: 'Decision removed. The group is undecided again; no file was touched.' };
    await jrRefreshSummary();
  } catch (error) {
    ui.status[key] = { kind: 'failed', message: `Not removed: ${error.message}` };
  }
  jrRender(fromStaleList ? 'summary-stale' : `summary-${sha}`);
}

/** Work out, per draft decision, exactly what an import would send. */
async function jrImportPreview() {
  const ui = janitorReviewUi;
  ui.importBusy = true;
  ui.importError = '';
  ui.importResult = null;
  jrRender('import-preview');
  const pending = ui.pending.slice(0, JR_IMPORT_CHECK_MAX);
  // A draft from before this page stored sizes and copies needs the report's group.
  const lookup = pending.filter((entry) => JR_SHA.test(entry.sha256) && !(Number(entry.size) > 0 && array(entry.paths).length > 1)).map((entry) => entry.sha256);
  const groups = new Map();
  let report = null;
  for (let index = 0; index < lookup.length; index += 50) {
    const result = await jrSettled(api(`/janitor/strategy/latest/groups?sha256=${lookup.slice(index, index + 50).join(',')}`));
    if (result.error) {
      ui.importBusy = false;
      ui.importError = `The preview could not be built: ${result.error}`;
      return jrRender('import-preview');
    }
    report = result.data.report || report;
    for (const group of array(result.data.groups)) groups.set(group.sha256, group);
  }
  const rows = pending.map((entry) => {
    const decision = JR_DRAFT_KINDS[entry.decision] || null;
    const row = { sha256: entry.sha256, decision, survivorPath: decision === 'dedupe' ? entry.keepPath : null, size: null, paths: null, pathsFrom: null, problem: '', report: null };
    if (!JR_SHA.test(entry.sha256)) return { ...row, problem: 'Not a SHA-256 content hash.' };
    if (!decision) return { ...row, problem: 'Unknown decision.' };
    const group = groups.get(entry.sha256);
    const seen = array(entry.paths).length > 1 ? entry.paths
      : decision === 'dedupe' && entry.keepPath && array(entry.removePaths).length ? [entry.keepPath, ...entry.removePaths] : null;
    if (seen) Object.assign(row, { paths: seen, pathsFrom: 'draft' });
    else if (group && !group.filesOmitted) Object.assign(row, { paths: array(group.files).map((file) => file.path), pathsFrom: 'report', report });
    row.size = Number(entry.size) > 0 ? Number(entry.size) : (group ? group.size : null);
    if (!row.paths || !row.size) return { ...row, problem: 'Not in the latest report: its copies and file size are unknown.' };
    if (row.paths.length > JR_PATHS_MAX) return { ...row, problem: `More than ${JR_PATHS_MAX} copies.` };
    if (decision === 'dedupe' && !row.paths.includes(row.survivorPath)) return { ...row, problem: 'The copy to keep is not among the copies.' };
    return row;
  });
  ui.importPreview = { rows };
  ui.importBusy = false;
  jrRender('import-run');
}

function jrImportPayload(row) {
  const generatedAt = row.pathsFrom === 'report' ? row.report?.generatedAt : state.janitorReviewDraftFrom;
  return {
    sha256: row.sha256,
    decision: row.decision,
    ...(row.decision === 'dedupe' ? { survivorPath: row.survivorPath } : {}),
    source: 'browser-draft-import',
    evidence: {
      size: row.size,
      paths: row.paths,
      ...(row.pathsFrom === 'report' && row.report?.id ? { reportId: row.report.id } : {}),
      ...(generatedAt && !Number.isNaN(new Date(generatedAt).getTime()) ? { reportGeneratedAt: generatedAt } : {})
    }
  };
}

async function jrImportRun() {
  const ui = janitorReviewUi;
  const rows = array(ui.importPreview?.rows);
  const ready = rows.filter((row) => !row.problem).map(jrImportPayload);
  if (!ready.length || ui.importBusy) return;
  ui.importBusy = true;
  ui.importError = '';
  jrRender('import-run');
  const outcome = { saved: 0, skipped: 0, failed: [], left: rows.length - ready.length };
  const send = async (decisions) => {
    const result = await api('/janitor/review-decisions/batch', { method: 'POST', payload: { mode: 'insert_missing', decisions } });
    outcome.saved += array(result.saved).length;
    outcome.skipped += array(result.skipped).length;
  };
  let batch = [];
  let size = 0;
  const batches = [];
  for (const decision of ready) {
    const weight = JSON.stringify(decision).length;
    if (batch.length && (batch.length >= JR_IMPORT_BATCH || size + weight > JR_IMPORT_BATCH_BYTES)) { batches.push(batch); batch = []; size = 0; }
    batch.push(decision);
    size += weight;
  }
  if (batch.length) batches.push(batch);
  for (const decisions of batches) {
    try { await send(decisions); }
    catch {
      // One refused entry refuses its whole batch: send that batch one by one to find it.
      for (const decision of decisions) {
        try { await send([decision]); }
        catch (error) { outcome.failed.push({ sha256: decision.sha256, message: error.message }); }
      }
    }
  }
  outcome.left += outcome.failed.length;
  if (outcome.saved + outcome.skipped > 0) {
    // The draft stays in the browser as a backup export, marked as imported.
    state.janitorReviewImportedAt = new Date().toISOString();
    persistJanitorReviewDraft();
  }
  ui.importResult = outcome;
  ui.importPreview = null;
  ui.importBusy = false;
  await jrLoad('summary-stale');
}

async function jrGo(action) {
  const ui = janitorReviewUi;
  if (ui.busy) return;
  if (action === 'next') {
    if (!Number.isFinite(ui.page?.nextOffset) || ui.page.nextOffset === null) return;
    ui.history.push(ui.offset);
    ui.offset = ui.page.nextOffset;
  } else {
    if (!ui.history.length) return;
    ui.offset = ui.history.pop();
  }
  await jrLoad(action);
}

document.addEventListener('click', async (event) => {
  const control = event.target.closest?.('[data-jr-action]');
  if (!control) return;
  const { jrAction: action, sha } = control.dataset;
  const ui = janitorReviewUi;
  try {
    if (['dedupe', 'keep_all', 'defer'].includes(action)) await jrDecide(sha, action);
    else if (action === 'undo') await jrUndo(sha, String(control.dataset.jrFocus || '').startsWith('undo-stale-'));
    else if (action === 'next' || action === 'previous') await jrGo(action);
    else if (action === 'import-preview') await jrImportPreview();
    else if (action === 'import-run') await jrImportRun();
    else if (action === 'import-cancel') { ui.importPreview = null; ui.importError = ''; jrRender('import-preview'); }
  } catch (error) {
    // No dialog: an unexpected failure is reported where the owner is looking.
    ui.busy = false;
    ui.importBusy = false;
    if (sha) ui.status[sha] = { kind: 'failed', message: error.message };
    else ui.importError = error.message;
    jrRender();
  }
});

document.addEventListener('change', (event) => {
  const target = event.target;
  const ui = janitorReviewUi;
  if (target?.dataset?.jrKeep) ui.selected[target.dataset.jrKeep] = target.value;
  if (target?.dataset?.jrFilter === 'undecided') {
    ui.undecidedOnly = target.checked === true;
    ui.offset = 0;
    ui.history = [];
    jrLoad('filter');
  }
});

document.addEventListener('input', (event) => {
  const sha = event.target?.dataset?.jrNote;
  if (sha) janitorReviewUi.notes[sha] = String(event.target.value || '').slice(0, JR_NOTE_MAX);
});

// `toggle` does not bubble: capture it to remember which groups are open across re-renders.
document.addEventListener('toggle', (event) => {
  const key = event.target?.dataset?.jrDetails;
  if (key) janitorReviewUi.open[key] = event.target.open === true;
}, true);
