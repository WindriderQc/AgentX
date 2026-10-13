/* Super Dad · My day (/dad/day). One compact bar says what the day holds and
   what needs Dad; the page then follows the order of action: focus, decisions'
   targets, mail to handle, tasks to schedule, and system health folded away.
   app.js routes here and lends its shared helpers through ctx. */
(function () {
  const icon = (path) => `<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${path}</svg>`;
  const ICONS = {
    day: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>',
    chat: '<path d="M21 12a8 8 0 0 1-11.6 7.1L4 20l1-4.6A8 8 0 1 1 21 12z"/>',
    refresh: '<path d="M21 12a9 9 0 1 1-2.6-6.4M21 4v5h-5"/>',
    speak: '<path d="M11 5 6 9H3v6h3l5 4V5zM15.5 8.5a5 5 0 0 1 0 7M18.5 5.5a9 9 0 0 1 0 13"/>'
  };
  const plural = (count, one, many) => `${count} ${count === 1 ? one : many}`;
  // Long lists show their first rows; the rest open on demand and stay open across refreshes.
  function clamp(host, limit = 5) {
    host.querySelector(':scope > .dad-more')?.remove();
    const rows = [...host.children];
    if (host.dataset.expanded === 'true' || rows.length <= limit) return;
    rows.slice(limit).forEach((row) => { row.hidden = true; });
    host.insertAdjacentHTML('beforeend', `<button type="button" class="compact dad-more">Show ${rows.length - limit} more</button>`);
    host.lastElementChild.addEventListener('click', () => { host.dataset.expanded = 'true'; rows.forEach((row) => { row.hidden = false; }); host.lastElementChild.remove(); });
  }

  // Bulk close for a backlog list: rows carry data-task-ref (and data-task-age in days).
  // Nothing closes before a second, explicit click on the confirm button.
  function selectable(list, { close, done, label = 'task' }) {
    const previous = list.previousElementSibling;
    if (previous?.classList.contains('dad-bulk')) previous.remove();
    const rows = [...list.querySelectorAll(':scope > [data-task-ref]')];
    if (rows.length < 2) return;
    rows.forEach((row) => row.insertAdjacentHTML('afterbegin', `<input type="checkbox" class="dad-select" aria-label="Select #${row.dataset.taskRef}">`));
    const old = rows.filter((row) => Number(row.dataset.taskAge) > 182).length;
    list.insertAdjacentHTML('beforebegin', `<div class="row wrap dad-bulk"><label class="dad-bulk-all"><input type="checkbox" data-bulk-all> All</label>${old ? `<button type="button" class="compact" data-bulk-old>Check the ${old} older than 6 months</button>` : ''}<button type="button" class="compact dad-done" data-bulk-close disabled>Close selection</button><span data-bulk-status class="muted" role="status"></span></div>`);
    const bar = list.previousElementSibling;
    const closeButton = bar.querySelector('[data-bulk-close]');
    const boxes = () => rows.map((row) => row.querySelector('.dad-select'));
    const chosen = () => rows.filter((row) => row.querySelector('.dad-select').checked);
    const reveal = () => list.querySelector(':scope > .dad-more')?.click();
    const sync = () => {
      const count = chosen().length;
      delete closeButton.dataset.confirm;
      closeButton.disabled = count === 0;
      closeButton.textContent = count ? `Close selection (${count})` : 'Close selection';
      bar.querySelector('[data-bulk-all]').checked = count === rows.length;
    };
    list.onchange = (event) => { if (event.target.classList.contains('dad-select')) sync(); };
    bar.querySelector('[data-bulk-all]').addEventListener('change', (event) => { reveal(); boxes().forEach((box) => { box.checked = event.target.checked; }); sync(); });
    bar.querySelector('[data-bulk-old]')?.addEventListener('click', () => { reveal(); rows.forEach((row) => { row.querySelector('.dad-select').checked = Number(row.dataset.taskAge) > 182; }); sync(); });
    closeButton.addEventListener('click', async () => {
      const refs = chosen().map((row) => row.dataset.taskRef);
      if (!closeButton.dataset.confirm) {
        closeButton.dataset.confirm = 'true';
        closeButton.textContent = `Confirm: close ${plural(refs.length, label, `${label}s`)}`;
        return;
      }
      closeButton.disabled = true;
      const status = bar.querySelector('[data-bulk-status]');
      let closed = 0;
      try {
        for (const ref of refs) { await close(ref); closed += 1; status.textContent = `${closed} / ${refs.length} closed…`; }
      } catch (error) { status.textContent = `${closed} closed, then: ${error.message}`; }
      await done(closed);
    });
  }

  function familyKnowledgeStarter() {
    return `---
title: Nestor Family Handbook
tags:
  - nestor
  - family
updated: YYYY-MM-DD
approval_status: draft
---

# Nestor Family Handbook

## Purpose and scope

This note is intended to contain only stable household guidance after Dad reads and approves it.
It excludes live tasks, schedules, secrets, exact locations, medical information, and emergency instructions.

## Household communication preferences

- Preferred language by situation: [replace or remove]
- Tone and answer length: [replace or remove]
- Words, explanations, or approaches to avoid: [replace or remove]

## Parent-approved house guidance

- [Add one stable, non-sensitive rule per bullet.]

## Learning support

- General approach safe for both children: [replace or remove]
- Reading or explanation preference: [replace or remove]
- When Nestor should tell the child to ask Dad: [replace or remove]

## Nestor response boundaries

- [Add one stable boundary that does not weaken the built-in safety policy.]

## Provenance and review

- Source: Dad
- Reviewed on: YYYY-MM-DD
- Intended lanes: [choose operator, family, reader, or the narrowest combination]
- Approval status: draft`;
  }

  async function copyTextField(toast, button, field, copiedMessage, selectedMessage) {
    const text = field.value.trim();
    if (!text) return;
    button.disabled = true;
    button.dataset.copyStatus = 'copying';
    try {
      if (!window.isSecureContext || !navigator.clipboard?.writeText) throw new Error('secure clipboard unavailable');
      await navigator.clipboard.writeText(text);
      button.dataset.copyStatus = 'copied';
      toast(copiedMessage);
    } catch (_error) {
      field.focus();
      field.select();
      button.dataset.copyStatus = 'selected';
      toast(selectedMessage);
    } finally {
      button.disabled = false;
    }
  }

  function template(esc, knowledgeStarter) {
    return `<section class="dad-bar" aria-label="My day">
        <div class="dad-bar-day"><span class="dad-bar-icon">${icon(ICONS.day)}</span><div><strong id="dadDate"></strong><small><time id="clock">--:--</time></small></div></div>
        <nav class="dad-counts" aria-label="My tasks">
          <a href="#dad-focus"><strong id="dadToday">—</strong><span>today</span></a>
          <a href="#dad-focus"><strong id="dadWeek">—</strong><span>next 7 days</span></a>
          <a href="#dad-focus" id="dadOverdueLink"><strong id="dadOverdue">—</strong><span>overdue</span></a>
          <a href="#dad-inbox"><strong id="dadInboxCount">—</strong><span>undated</span></a>
        </nav>
        <div class="dad-bar-actions">
          <a class="button compact dad-icon-button" href="/dad" title="Open a conversation">${icon(ICONS.chat)}<span>Conversation</span></a>
          <button id="dadRefresh" class="compact dad-icon-button" type="button" title="Refresh">${icon(ICONS.refresh)}<span>Refresh</span></button>
          <button id="dadSpeak" class="compact dad-icon-button" type="button" title="Listen to my day" disabled>${icon(ICONS.speak)}<span>Listen</span></button>
        </div>
      </section>
      <section class="dad-decide" aria-labelledby="dadDecideTitle"><h2 id="dadDecideTitle" class="card-kicker">To decide</h2><div id="dadDecisions" class="dad-decide-list" aria-live="polite"><span class="dad-decide-empty">Loading…</span></div></section>
      <section class="dad-grid">
        <article class="card dad-focus" id="dad-focus"><div class="row"><div class="grow"><p class="card-kicker">Today and next 7 days</p><h2>Focus</h2></div><span id="dadFocusCount" class="pill">…</span></div><div id="dadFocus" class="stack"></div></article>
        <div class="dad-side">
          <article class="card dad-capture"><p class="card-kicker">Capture</p><h2>Note a task</h2><form id="dadCaptureForm" class="stack"><input id="dadCaptureTitle" maxlength="200" required placeholder="What needs doing?" aria-label="Personal task"><div class="row"><input id="dadCaptureDue" type="date" aria-label="Due date"><select id="dadCapturePriority" aria-label="Priority"><option value="3">Normal</option><option value="2">High</option><option value="4">Low</option></select></div><button class="primary">Add to my list</button></form><p class="muted dad-quiet">A personal task. Platform work stays in Pipeline.</p></article>
        </div>
        <article class="card full dad-mail-actions" id="dad-mail-actions"><div class="row"><div class="grow"><p class="card-kicker">Email · to handle</p><h2>Urgent and awaiting replies</h2></div><span id="dadMailActionCount" class="pill">loading…</span></div><div class="dad-mail-columns"><section><h3>Urgent</h3><div id="dadMailUrgent" class="stack dad-mail-list"><div class="empty">Reading Gmail…</div></div></section><section><h3>To reply</h3><div id="dadMailReply" class="stack dad-mail-list"><div class="empty">Reading Gmail…</div></div></section></div><p class="muted dad-quiet">Sorted by the Secretary. “Handled” only removes this label in Gmail: nothing is sent, archived or deleted.</p></article>
        <article class="card full dad-inbox" id="dad-inbox"><div class="row"><div class="grow"><p class="card-kicker">To schedule</p><h2>Give a date, or finish</h2><p class="muted">Nothing moves on its own: each button updates the task, and nothing else.</p></div><span id="dadStaleCount" class="pill">…</span></div><div id="dadInbox" class="stack"></div><p id="dadInboxShown" class="muted dad-quiet"></p></article>
        <details class="card full dad-secondary" id="dad-mail"><summary>Automatic email triage <span id="dadMailPill" class="pill">…</span></summary><p id="dadMailSummary" class="muted">Checking triage…</p><div id="dadMailJobs" class="stack"></div><div class="row wrap dad-reminder-actions"><a class="button compact" href="/api/openclaw/control-launch/cron">Open automations</a></div><details class="dad-secondary dad-rules" data-secretary-rules></details></details>
        <details class="card full dad-secondary" id="dad-health"><summary>System health <span id="dadHealthPill" class="pill">…</span></summary><div class="dad-evidence-grid"><section><strong>Memory review</strong><div id="dadMemoryStates" class="stack"></div><p id="dadMemory" class="muted">Checking…</p><a href="/memory-review">Open the review</a></section><section><strong>LLM usage</strong><div id="dadUtilization" class="stack"></div><a href="/analytics">Open Analytics</a></section><section><strong>System exceptions</strong><p id="dadOps" class="muted">Checking…</p><a href="/agent-ops">Open Agent Ops</a></section></div></details>
        <details class="card full dad-secondary"><summary>Reminders & household organization</summary><div class="grid"><article class="card dad-reminder"><div class="row"><div class="grow"><p class="card-kicker">Personal reminder · consent first</p><h2>Morning reminder</h2></div><span id="dadReminderState" class="pill">…</span></div><p id="dadReminderSummary" class="muted">Checking…</p><p id="dadReminderConsent" class="muted dad-quiet">No message is sent until Dad turns it on.</p><div class="row wrap dad-reminder-actions"><button id="dadReminderPreviewToggle" class="compact" type="button" aria-expanded="false" aria-controls="dadReminderPreview" disabled>Preview reminder</button><a class="button compact" href="/api/openclaw/control-launch/cron">Review the daily reminder</a></div><div id="dadReminderPreview" class="reminder-preview" hidden><div class="reminder-preview-heading"><span class="pill ok">preview only</span><strong>Nothing ran. Nothing was sent.</strong></div><pre id="dadReminderMessage" lang="fr"></pre><div id="dadReminderContract" class="reminder-contract"></div><p id="dadReminderPreviewNote" class="muted dad-quiet"></p></div></article>
          <article class="card dad-family"><div class="row"><div class="grow"><p class="card-kicker">Household rhythm · parent</p><h2>Kids space setup</h2></div><span id="dadFamilyState" class="pill">…</span></div><p id="dadFamilySummary" class="muted">Checking profiles and routines…</p><div id="dadFamilyCounts" class="service"></div><a class="button compact" href="/dad/family">Open family tracking</a></article>
          <article class="card full dad-activation"><div class="row"><div class="grow"><p class="card-kicker">Setup · Dad</p><h2>Finish setup without giving up consent</h2><p class="muted">Every remaining step is visible here. Opening a step changes nothing: its screen asks separately before any write, delivery or physical check.</p></div><span id="dadActivationState" class="pill">…</span></div><div id="dadActivationItems" class="stack"><div class="empty">Checking steps…</div></div></article>
        </div></details>
        <details class="card full dad-secondary" id="knowledge"><summary>Family & Reading knowledge</summary><p>To review before Nestor learns it. Different from the personal notebook: this corpus is limited to approved Family and Reading guidance.</p><span id="dadKnowledgeState" class="pill">…</span><p id="dadKnowledgeSummary"></p><div id="dadKnowledgeMetrics"></div><p id="dadKnowledgeFingerprint" class="muted"></p><p>This space is read-only. It cannot read document contents, prepare a file, ingest a corpus or turn on search.</p><details><summary>Start from a blank guide</summary><p>This draft only contains templates. Ask Nestor to help you review it before adding family knowledge.</p><textarea id="dadKnowledgeStarterText" rows="10" readonly>${esc(knowledgeStarter)}</textarea><button id="dadKnowledgeStarterCopy" type="button">Copy the blank guide</button></details></details>
      </section>`;
  }

  async function load(ctx) {
    const { app, api, esc, toast, setRuntime, speak, clock } = ctx;
    app.innerHTML = template(esc, familyKnowledgeStarter());
    const shopping = document.createElement('article'); shopping.className = 'card full dad-shopping';
    app.querySelector('.dad-grid').append(shopping);
    window.HouseholdShopping.mount({ host: shopping, api, esc, canBuy: true });
    const byId = (id) => document.getElementById(id);
    const setPill = (id, text, tone = '') => { const node = byId(id); node.textContent = text; node.className = `pill ${tone}`; };
    byId('dadDate').textContent = new Intl.DateTimeFormat('en-CA', { weekday: 'long', day: 'numeric', month: 'long' }).format(new Date());
    clock(); const clockTimer = setInterval(clock, 30000);
    window.addEventListener('pagehide', () => clearInterval(clockTimer), { once: true });
    let latestDesk = null;

    const dueLabel = (task) => task.overdue ? 'overdue' : task.dueToday ? 'today' : task.dueAt ? new Intl.DateTimeFormat('en-CA', { month: 'short', day: 'numeric' }).format(new Date(task.dueAt)) : 'undated';
    const originLabel = { chat: 'chat', email: 'email', manual: 'manual' };
    const taskRow = (task, triage = false) => `<div class="dad-task ${task.overdue ? 'overdue' : task.dueToday ? 'due-today' : task.stale ? 'stale' : ''}"${triage ? ` data-task-ref="${esc(task.id)}" data-task-age="${esc(task.ageDays ?? '')}"` : ''}><div class="dad-task-main"><span class="dad-task-id">#${esc(task.id)}</span><div><strong>${esc(task.title)}</strong><small>${esc(dueLabel(task))}${task.ageDays !== null && task.unscheduled ? ` · ${esc(task.ageDays)} d undated` : ''} · P${esc(task.priority)} · <span class="dad-origin" title="${esc(task.source || '')}">${esc(originLabel[task.origin] || 'manual')}</span></small></div></div><div class="row wrap dad-task-actions">${triage ? `<button class="compact" data-ref="${esc(task.id)}" data-schedule="0">Today</button><button class="compact" data-ref="${esc(task.id)}" data-schedule="1">Tomorrow</button><button class="compact" data-ref="${esc(task.id)}" data-schedule="7">Next week</button>${task.priority > 1 ? `<button class="compact" data-ref="${esc(task.id)}" data-priority="1">High priority</button>` : ''}` : `<button class="compact" data-ref="${esc(task.id)}" data-schedule="1">Move to tomorrow</button>`}<button class="compact dad-done" data-ref="${esc(task.id)}" data-action="done">Done</button></div></div>`;
    const jobStatus = (job) => !job.enabled ? 'stopped' : job.late ? 'late' : ({ ok: 'ok', success: 'ok', error: 'error', unknown: 'unknown' }[job.lastStatus] || job.lastStatus);
    const jobRow = (job, label) => job ? `<div class="service"><div><strong>${esc(label)}</strong><small>${job.lastRunAt ? `last run ${esc(new Date(job.lastRunAt).toLocaleString('en-CA', { dateStyle: 'medium', timeStyle: 'short' }))}${job.ageHours !== null && job.ageHours !== undefined ? ` · ${esc(job.ageHours)} h ago` : ''}` : 'no run receipt'}</small></div><span class="pill ${job.healthy ? 'ok' : 'down'}">${esc(jobStatus(job))}</span></div>` : `<div class="service"><div><strong>${esc(label)}</strong><small>evidence missing</small></div><span class="pill down">unknown</span></div>`;
    const backlogRow = (mail) => {
      const backlog = mail.backlog || {};
      if (!Number.isInteger(backlog.unlabelled)) return `<div class="service"><div><strong>Unlabelled emails</strong><small>${esc(backlog.error || 'count unavailable')}</small></div><span class="pill">unknown</span></div>`;
      const waiting = backlog.unlabelled > 0;
      return `<div class="service"><div><strong>Unlabelled emails</strong><small>last ${esc(backlog.days)} days${backlog.checkedAt ? ` · counted at ${esc(new Date(backlog.checkedAt).toLocaleTimeString('en-CA', { timeStyle: 'short' }))}` : ''}</small></div><span class="pill ${waiting && mail.status === 'stopped' ? 'down' : waiting ? '' : 'ok'}">${esc(backlog.unlabelled)}${backlog.capped ? '+' : ''}</span></div>`;
    };
    // The archive catch-up job (#130): counts only, shown while it runs and once it ends.
    const catchupState = { running: ['running', 'ok'], paused: ['paused', ''], done: ['done', 'ok'], partial: ['partial', ''], stopped: ['stopped', 'down'], idle: ['waiting', ''], unavailable: ['unknown', ''] };
    const catchupRow = (mail) => {
      const job = mail.catchup;
      if (!job) return '';
      const [label, tone] = catchupState[job.status] || catchupState.idle;
      const total = (job.reviewed ?? 0) + (job.remaining ?? 0) + (job.failed ?? 0);
      const detail = job.status === 'unavailable' ? (job.error || 'status unavailable')
        : [`${job.reviewed ?? 0} / ${total} pages reviewed`,
          job.failed ? `${job.failed} with errors` : '',
          job.status === 'running' && job.etaHours !== null ? `estimated finish in ${job.etaHours} h (${job.pagesPerHour} pages/h)` : '',
          job.paused ? `paused: ${job.paused}` : '',
          job.proposalsQueued ? `${job.proposalsQueued} to confirm in the idea inbox` : ''].filter(Boolean).join(' · ');
      return `<div class="service"><div><strong>Archive review</strong><small>${esc(detail)}</small></div><span class="pill ${tone}">${esc(label)}</span></div>`;
    };
    // Each decision says what and links to where it is settled; nothing hides behind a bare "needs decisions".
    const decisionChip = (decision) => `<a class="dad-decide-chip ${decision.severity === 'warning' ? 'warning' : ''}" href="${esc(decision.href || '/dad')}"><strong>${esc(decision.title)}</strong><small>${esc(decision.detail)}</small></a>`;
    const mailLabel = { ready: ['running', 'ok'], stopped: ['stopped', 'down'], attention: ['to check', 'waiting'], unavailable: ['unavailable', 'down'] };
    const renderReminderPreview = (reminder) => {
      const preview = reminder?.preview;
      const toggle = byId('dadReminderPreviewToggle');
      if (!preview) { toggle.disabled = true; return; }
      byId('dadReminderMessage').textContent = preview.message;
      byId('dadReminderContract').innerHTML = `<span><strong>${esc(reminder.schedule)}</strong><small>schedule</small></span><span><strong>1 read-only call</strong><small>${esc(preview.contract.composer)}</small></span><span><strong>No note · no write</strong><small>${esc(preview.counts.open)} open tasks read</small></span>`;
      byId('dadReminderPreviewNote').textContent = preview.note;
      toggle.disabled = false;
    };

    async function refreshDad() {
      try {
        const data = await api('/api/secretary/desk');
        latestDesk = data;
        setRuntime(true, 'day ready');
        const decisions = Array.isArray(data.decisions) ? data.decisions : [];
        const mailState = mailLabel[data.mail.status] || mailLabel.attention;
        // A stopped triage already arrives as a decision; a softer mail doubt still earns a chip.
        const mailChip = ['attention', 'unavailable'].includes(data.mail.status)
          ? `<a class="dad-decide-chip" href="#dad-mail"><strong>Email triage ${esc(mailState[0])}</strong><small>${esc(data.mail.summary)}</small></a>` : '';
        byId('dadDecisions').innerHTML = decisions.length || mailChip
          ? decisions.map(decisionChip).join('') + mailChip
          : '<span class="dad-decide-empty ok">✓ Nothing to decide right now.</span>';
        byId('dadToday').textContent = data.metrics.today;
        byId('dadWeek').textContent = data.upcoming.length;
        byId('dadOverdue').textContent = data.metrics.overdue;
        byId('dadOverdueLink').classList.toggle('alert', data.metrics.overdue > 0);
        byId('dadInboxCount').textContent = data.metrics.inbox;
        setPill('dadFocusCount', plural(data.focus.length, 'task', 'tasks'));
        byId('dadFocus').innerHTML = data.focus.length ? data.focus.map((task) => taskRow(task)).join('') : '<div class="dad-clear"><span>✓</span><strong>Nothing planned for the next seven days.</strong><small>Give a date to a “To schedule” task.</small></div>';
        clamp(byId('dadFocus'), matchMedia('(max-width: 560px)').matches ? 3 : 5);
        setPill('dadStaleCount', `${data.metrics.stale} waiting a long time`, data.metrics.stale ? 'down' : 'ok');
        byId('dadInbox').innerHTML = data.inbox.length ? data.inbox.map((task) => taskRow(task, true)).join('') : '<div class="dad-clear"><span>✓</span><strong>Everything is scheduled.</strong><small>Every open task has a date.</small></div>';
        clamp(byId('dadInbox'), 3);
        selectable(byId('dadInbox'), { close: (ref) => api('/api/secretary/tasks/complete', { method: 'POST', body: JSON.stringify({ ref, note: 'Fermée en lot depuis Ma journée.', by: 'household-dad-desk' }) }), done: () => refreshDad() });
        byId('dadInboxShown').textContent = data.metrics.inbox > data.inbox.length ? `${data.metrics.inbox} undated tasks: the list keeps ${data.inbox.length} at a time; the next ones appear once these have a date.` : '';
        setPill('dadMailPill', mailState[0], mailState[1]);
        byId('dadMailSummary').textContent = data.mail.summary;
        byId('dadMailSummary').classList.toggle('dad-alert', data.mail.status === 'stopped');
        byId('dadMailJobs').innerHTML = jobRow(data.mail.triage, 'Gmail triage (new email)') + backlogRow(data.mail) + catchupRow(data.mail) + jobRow(data.mail.watchdog, 'Health watchdog') + jobRow(data.mail.morning, 'Morning briefing');
        setPill('dadReminderState', data.reminder.status, ['active', 'pending'].includes(data.reminder.status) ? 'ok' : data.reminder.status === 'off' ? '' : 'down');
        byId('dadReminderSummary').textContent = `${data.reminder.summary} · ${data.reminder.schedule}`;
        byId('dadReminderConsent').textContent = data.reminder.consent;
        renderReminderPreview(data.reminder);
        setPill('dadFamilyState', data.family.status.replace('_', ' '), data.family.status === 'ready' ? 'ok' : data.family.status === 'review' ? 'down' : '');
        byId('dadFamilySummary').textContent = data.family.summary;
        byId('dadFamilyCounts').innerHTML = `<span>${plural(data.family.profiles, 'profile', 'profiles')}</span><strong>${plural(data.family.routines, 'routine', 'routines')} · ${data.family.waiting} waiting</strong>`;
        const activation = data.activation || { status: 'unavailable', pendingGates: 0, attentionGates: 1, items: [] };
        const activationOpen = Number(activation.pendingGates || 0) + Number(activation.attentionGates || 0);
        setPill('dadActivationState', activation.status === 'ready' ? 'ready' : activation.status === 'unavailable' ? 'unavailable' : `${activationOpen} for Dad`, activation.status === 'ready' ? 'ok' : activation.status === 'attention' || activation.status === 'unavailable' ? 'down' : '');
        byId('dadActivationItems').innerHTML = activation.items?.length
          ? activation.items.map((item) => `<a class="service" href="${esc(item.href)}"><div><strong>${esc(item.label)}</strong><small>${esc(item.detail)}</small></div><span class="pill ${item.status === 'ready' ? 'ok' : item.status === 'attention' ? 'down' : ''}">${esc(item.status)}</span></a>`).join('')
          : `<div class="empty">${esc(activation.error || 'Setup steps are unavailable.')}</div>`;
        byId('dadOps').textContent = data.operations.summary;
        const memoryProvenance = data.memoryReview.provenance || { status: 'unavailable' };
        byId('dadMemoryStates').innerHTML = `<div class="service"><span>Proposal queue</span><strong>${esc(data.memoryReview.queueStatus || 'unavailable')}</strong></div><div class="service"><span>Collector provenance</span><strong>${esc(memoryProvenance.status)}</strong></div>`;
        byId('dadMemory').textContent = data.memoryReview.summary;
        const utilization = data.utilization || {};
        byId('dadUtilization').innerHTML = `<div class="service"><span>Local activity</span><strong>${esc(utilization.localActivity || 'unknown')} · ${Number(utilization.localUsageRatio || 0).toFixed(2)}× baseline</strong></div><div class="service"><span>Budget cloud</span><strong>${esc(utilization.cloudHealth || 'unknown')} · ${Number(utilization.cloudRequests || 0)} calls · ${esc(utilization.cloudObservability || 'unknown')}</strong></div>`;
        const healthIssue = data.operations.status !== 'clear' || ['attention', 'unavailable'].includes(data.memoryReview.status) || utilization.status !== 'clear';
        setPill('dadHealthPill', healthIssue ? 'to check' : 'ok', healthIssue ? 'waiting' : 'ok');
        byId('dadSpeak').disabled = false;
      } catch (error) { setRuntime(false, 'day unavailable'); toast(error.message); }
    }

    // Gmail is read through the OpenClaw host and takes seconds; it never delays the desk itself.
    const mailLists = { urgent: 'dadMailUrgent', 'needs-reply': 'dadMailReply' };
    const mailCounts = {};
    const senderName = (from) => String(from || '').replace(/\s*<[^>]*>\s*$/, '').replace(/^"|"$/g, '') || String(from || '');
    const mailRow = (thread, label) => `<div class="dad-task ${thread.unread ? 'due-today' : ''}"><div class="dad-task-main dad-mail-main"><div><strong>${esc(thread.subject || '(no subject)')}</strong><small>${esc(senderName(thread.from))} · ${esc(thread.date)}${thread.messageCount > 1 ? ` · ${esc(thread.messageCount)} messages` : ''}${thread.unread ? ' · unread' : ''}</small></div></div><div class="row wrap dad-task-actions">${String(thread.gmailUrl || '').startsWith('https://mail.google.com/') ? `<a class="button compact" href="${esc(thread.gmailUrl)}" target="_blank" rel="noopener noreferrer">Open</a>` : ''}<button class="compact dad-done" data-mail-thread="${esc(thread.threadId)}" data-mail-label="${esc(label)}">Handled</button></div></div>`;
    const showMailCount = () => {
      const known = Object.values(mailCounts).filter(Boolean);
      if (known.length < Object.keys(mailLists).length) { setPill('dadMailActionCount', 'unavailable', 'down'); return; }
      const total = known.reduce((sum, entry) => sum + entry.count, 0);
      setPill('dadMailActionCount', `${total}${known.some((entry) => entry.more) ? '+' : ''} to handle`, total ? '' : 'ok');
    };
    async function refreshMail() {
      await Promise.all(Object.entries(mailLists).map(async ([label, hostId]) => {
        const host = byId(hostId);
        try {
          const data = await api(`/api/secretary/mail?label=${encodeURIComponent(label)}`);
          mailCounts[label] = { count: data.count, more: data.more === true };
          host.innerHTML = data.threads.length ? data.threads.map((thread) => mailRow(thread, label)).join('') : '<div class="dad-clear"><span>✓</span><strong>Nothing to handle.</strong></div>';
        } catch (error) {
          mailCounts[label] = null;
          host.innerHTML = `<div class="empty">${esc(error.message)}</div>`;
        }
      }));
      showMailCount();
    }

    // In-page links (counts, decision chips) open the folded section they point into.
    const reveal = (hash) => {
      const target = hash.length > 1 && byId(decodeURIComponent(hash.slice(1)));
      if (!target) return false;
      for (let node = target; node; node = node.parentElement?.closest('details')) if (node.tagName === 'DETAILS') node.open = true;
      target.scrollIntoView({ behavior: 'smooth', block: 'start' });
      return true;
    };
    app.addEventListener('click', (event) => {
      const link = event.target.closest('a[href^="#"]');
      if (link && reveal(link.getAttribute('href'))) { event.preventDefault(); history.replaceState(null, '', link.getAttribute('href')); }
    });

    const noonAfter = (days) => { const due = new Date(); due.setHours(12, 0, 0, 0); due.setDate(due.getDate() + days); return due.toISOString(); };
    async function updateTask(ref, body) {
      await api('/api/secretary/tasks/update', { method: 'POST', body: JSON.stringify({ ref, by: 'household-dad-desk', ...body }) });
      await refreshDad();
    }
    app.addEventListener('click', async (event) => {
      const handled = event.target.closest('button[data-mail-thread]');
      if (!handled) return;
      handled.disabled = true;
      try {
        await api('/api/secretary/mail/handled', { method: 'POST', body: JSON.stringify({ threadId: handled.dataset.mailThread, label: handled.dataset.mailLabel }) });
        const entry = mailCounts[handled.dataset.mailLabel];
        if (entry) entry.count = Math.max(0, entry.count - 1);
        handled.closest('.dad-task').remove();
        showMailCount();
      } catch (error) { handled.disabled = false; toast(error.message); }
    });
    app.addEventListener('click', async (event) => {
      const button = event.target.closest('button[data-ref]');
      if (!button) return;
      button.disabled = true;
      try {
        if (button.dataset.action === 'done') {
          if (button.dataset.confirmed !== 'true') { button.dataset.confirmed = 'true'; button.textContent = 'Confirm'; button.disabled = false; return; }
          await api('/api/secretary/tasks/complete', { method: 'POST', body: JSON.stringify({ ref: button.dataset.ref, by: 'household-dad-desk' }) });
          await refreshDad();
        } else if (button.dataset.schedule !== undefined) await updateTask(button.dataset.ref, { dueAt: noonAfter(Number(button.dataset.schedule)) });
        else if (button.dataset.priority) await updateTask(button.dataset.ref, { priority: Number(button.dataset.priority) });
      } catch (error) { button.disabled = false; toast(error.message); }
    });
    byId('dadCaptureForm').addEventListener('submit', async (event) => {
      event.preventDefault();
      const button = event.target.querySelector('button.primary');
      if (button.disabled) return; button.disabled = true;
      const title = byId('dadCaptureTitle');
      const due = byId('dadCaptureDue');
      try {
        await api('/api/secretary/tasks', { method: 'POST', body: JSON.stringify({ title: title.value, dueAt: due.value || null, priority: Number(byId('dadCapturePriority').value), source: 'household-dad-desk' }) });
        title.value = ''; due.value = ''; byId('dadCapturePriority').value = '3';
        await refreshDad();
      } catch (error) { toast(error.message); }
      finally { button.disabled = false; }
    });
    byId('dadRefresh').addEventListener('click', () => { refreshDad(); refreshMail(); });
    byId('dadReminderPreviewToggle').addEventListener('click', (event) => {
      const panel = byId('dadReminderPreview');
      const willOpen = panel.hidden;
      panel.hidden = !willOpen;
      event.currentTarget.setAttribute('aria-expanded', String(willOpen));
      event.currentTarget.textContent = willOpen ? 'Hide preview' : 'Preview reminder';
    });
    byId('dadSpeak').addEventListener('click', () => {
      if (!latestDesk) return;
      const decisions = Array.isArray(latestDesk.decisions) ? latestDesk.decisions : [];
      speak([latestDesk.headline, latestDesk.focus.length ? `Focus: ${latestDesk.focus.map((task) => task.title).join(', ')}.` : '', decisions.length ? `To decide. ${decisions.map((decision) => `${decision.title}. ${decision.detail}`).join(' ')}` : 'Nothing to decide right now.', latestDesk.mail.summary].filter(Boolean).join(' '), 'en');
    });

    async function refreshKnowledgeApproval() {
      const badge = byId('dadKnowledgeState');
      try {
        const data = await api('/api/voice-personas/knowledge/status');
        const knowledge = data.knowledge || {};
        if (knowledge.pathsIncluded !== false || knowledge.contentIncluded !== false || knowledge.legacySourcesEligible !== false) {
          throw new Error('Knowledge status privacy contract drifted');
        }
        const documents = Math.max(0, Number(knowledge.documentCount) || 0);
        const active = knowledge.enabled === true && documents > 0;
        const staged = !active && documents > 0;
        badge.textContent = active ? 'active' : staged ? 'prepared · search off' : 'waiting for a candidate';
        badge.className = `pill ${active ? 'ok' : ''}`;
        byId('dadKnowledgeSummary').textContent = active
          ? `${plural(documents, 'document', 'documents')} approved by the parent, available to the declared lanes.`
          : staged
            ? `${plural(documents, 'document', 'documents')} prepared. Dad must review the receipt before a separate activation.`
            : 'No family document prepared. Search is off and older RAG sources remain ineligible.';
        const lanes = knowledge.laneCounts || {};
        byId('dadKnowledgeMetrics').innerHTML = ['operator', 'family', 'reader'].map((lane) => `<span><strong>${Math.max(0, Number(lanes[lane]) || 0)}</strong><small>${esc(lane)} lane</small></span>`).join('');
        byId('dadKnowledgeFingerprint').textContent = documents && knowledge.corpusFingerprint
          ? `Corpus fingerprint: ${knowledge.corpusFingerprint}`
          : 'No approved candidate is prepared.';
      } catch (error) {
        badge.textContent = 'unavailable';
        badge.className = 'pill down';
        byId('dadKnowledgeSummary').textContent = 'The knowledge status could not be checked. Search stays closed.';
        byId('dadKnowledgeMetrics').innerHTML = '';
        byId('dadKnowledgeFingerprint').textContent = 'No approval can be inferred while the status is unavailable.';
      }
    }

    byId('dadKnowledgeStarterCopy').addEventListener('click', (event) => copyTextField(toast, event.currentTarget, byId('dadKnowledgeStarterText'), 'Blank guide copied · nothing saved or approved', 'Blank guide selected'));
    refreshKnowledgeApproval();
    refreshMail();
    await refreshDad();
    if (location.hash) reveal(location.hash);
  }

  window.HouseholdDadDay = { load, clamp, selectable };
}());
