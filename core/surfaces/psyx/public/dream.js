'use strict';

// The portrait PsyX writes between sessions, and the trace of what each of
// those reflections changed in memory. PsyX writes directly; the user reads,
// removes what is not him, and can undo a whole reflection. Loaded before
// app.js, whose shared state and helpers these functions use at call time.

const PORTRAIT_TITLES = {
  situation: 'Your situation', loops: 'Recurring loops', triggers: 'What triggers you', relationships: 'Your relationships',
  strengths: 'Your strengths', values: 'What matters to you', whatWorks: 'What works for you', blindSpots: 'Possible blind spots', health: 'Health'
};
const DREAM_KIND_LABELS = { night: 'last night', session: 'after your session', manual: 'at your request' };
const DREAM_SOURCE_LABELS = { notes: 'Nestor notes', tasks: 'tasks and reminders', mail: 'email log' };
const INTAKE_LABELS = { currentSituation: 'your current situation', reasonsAndGoals: 'what you are looking for', familyOfOrigin: 'your family of origin', relationships: 'your relationships',
  children: 'your children', work: 'your work', physicalHealth: 'your physical health', sleep: 'your sleep', substances: 'alcohol and substances', supports: 'your support network', pastHelp: 'help you have already received' };
const DREAM_SEEN_KEY = 'psyx.dream.seen';
const DREAM_POLL_MS = 60000;

const dream = { status: null, timer: null };

function dreamSeen() {
  try { return localStorage.getItem(DREAM_SEEN_KEY); } catch { return null; }
}

function markDreamSeen() {
  const id = state.psyxState?.portrait?.id;
  try { if (id) localStorage.setItem(DREAM_SEEN_KEY, id); } catch { /* the chip simply shows again */ }
  renderDreamChip();
}

function renderDreamChip() {
  const chip = $('dreamStatus');
  const portrait = state.psyxState?.portrait;
  const running = dream.status?.status === 'running';
  const fresh = Boolean(portrait?.id) && portrait.id !== dreamSeen();
  chip.hidden = !running && !fresh;
  chip.classList.toggle('running', running);
  chip.classList.toggle('has-proposals', !running && fresh);
  const findings = portrait?.findings?.length || 0;
  chip.textContent = running
    ? 'PsyX is deepening your portrait…'
    : `PsyX deepened your portrait ${DREAM_KIND_LABELS[portrait?.kind] || ''}${findings ? ` · ${findings} finding${findings === 1 ? '' : 's'}` : ''}`;
  chip.title = 'Between sessions, PsyX deepens what it understands about you. The portrait shows how much text was analyzed. You can read, remove and undo.';
  $('tabUnderstanding').dataset.badge = fresh && !running ? '•' : '';
}

function portraitList(title, items) {
  return items?.length ? `<section class="state-section"><h4>${escapeHtml(title)}</h4><ul class="portrait-list">${items.map(item => `<li>${escapeHtml(item.text || item)}${
    portraitEvidence(item)}</li>`).join('')}</ul></section>` : '';
}

function portraitEvidence(item) {
  const labels = { conversation: 'your words in session', profile: 'your profile', memory: 'your memory',
    experiment: 'your recorded experiment', checkIn: 'your check-in', assessment: 'your scored questionnaire', ...DREAM_SOURCE_LABELS };
  return (item.evidence || []).map(quote => {
    const ref = (item.evidenceRefs || []).find(candidate => candidate.quote === quote);
    const source = ref ? `Quote found in ${labels[ref.kind] || 'the source'}` : 'Older quote: source not verified';
    const open = ref?.kind === 'conversation' && /^[a-f0-9]{24}$/i.test(ref.conversationId || '') && Number.isSafeInteger(ref.messageIndex)
      ? `<button type="button" data-evidence-session="${escapeHtml(ref.conversationId)}" data-evidence-index="${ref.messageIndex}" data-evidence-quote="${escapeHtml(quote)}">Read the source message</button><p class="portrait-source" hidden></p>` : '';
    return `<blockquote>${escapeHtml(quote)}<small>${escapeHtml(source)}</small>${open}</blockquote>`;
  }).join('');
}

// How much of an intake PsyX has covered so far; the rest is asked over time, never all at once.
function intakeSummary(intake = {}) {
  const domains = Object.keys(INTAKE_LABELS);
  const known = domains.filter(key => intake[key] === 'known').length;
  const partial = domains.filter(key => intake[key] === 'partial').length;
  const missing = domains.filter(key => !intake[key] || intake[key] === 'unknown').map(key => INTAKE_LABELS[key]);
  // A portrait written before the intake existed says nothing about it.
  if (!known && !partial) return '';
  return `<section class="state-section"><h4>What PsyX knows about your life</h4><p class="state-help">${known} of ${domains.length} area${domains.length === 1 ? '' : 's'} well known${partial ? `, ${partial} partly` : ''}.${
    missing.length ? ` Still to discover, one question at a time: ${escapeHtml(missing.join(', '))}.` : ''}</p></section>`;
}

function renderPortrait() {
  const portrait = state.psyxState?.portrait;
  const log = (state.psyxState?.dreamLog || []).filter(entry => !entry.undone && (entry.added.length || entry.retired.length || entry.id === portrait?.id)).slice(-5).reverse();
  const running = dream.status?.status === 'running';
  $('dreamNow').disabled = running || !dream.status?.enabled;
  $('dreamNow').textContent = running ? 'PsyX is reflecting…' : 'Reflect deeper now';
  if (!portrait?.sections?.length) {
    $('portraitMeta').textContent = dream.status?.status === 'failed' ? 'The last reflection did not complete. It will run again next night.' : '';
    $('portraitView').innerHTML = `<p class="state-empty">${running ? 'PsyX is writing your portrait…' : state.conversationFeatures?.dreamEnabled === false ? 'Dreaming is turned off in Context and performance.' : state.conversationFeatures?.automaticDream === false ? 'No portrait yet. You can request a reflection with Reflect deeper now.' : 'No portrait yet. PsyX writes it after your sessions and every night, from the available context.'}</p>`;
  } else {
    const sources = (portrait.sources || []).map(key => DREAM_SOURCE_LABELS[key] || key);
    $('portraitMeta').textContent = [dream.status?.status === 'failed' ? 'The last reflection did not complete' : null, `Written ${new Date(portrait.updatedAt).toLocaleString('en-CA', { dateStyle: 'long', timeStyle: 'short' })}`,
      dreamCoverageLabel(portrait.covers),
      sources.length ? `with ${sources.join(', ')}` : null,
      portrait.location === 'frontier' ? 'cloud reflection' : 'local reflection'].filter(Boolean).join(' · ');
    $('portraitView').innerHTML = portrait.sections.map(section => `<section class="state-section"><h4>${escapeHtml(PORTRAIT_TITLES[section.key] || section.key)}</h4>${section.statements.map(item => `
      <article class="proposal-card portrait-statement">
        <strong>${escapeHtml(item.text)}</strong>${Number.isFinite(item.confidence) ? `<small>confidence ${Math.round(item.confidence * 100)}%</small>` : ''}
        ${portraitEvidence(item)}
        <div class="proposal-actions"><button type="button" data-portrait-reject="${escapeHtml(item.id)}">That’s not me</button></div>
      </article>`).join('')}</section>`).join('')
      + intakeSummary(portrait.intake)
      + portraitList('What PsyX sees from one session to the next', portrait.findings)
      + portraitList('To explore in the next session', portrait.agenda)
      + portraitList('What PsyX would like to understand better', portrait.questions);
  }
  $('dreamLog').innerHTML = log.length ? `<section class="state-section"><h4>What these reflections changed in memory</h4>${log.map(entry => `
    <article class="proposal-card">
      <small>${escapeHtml(new Date(entry.at).toLocaleString('en-CA', { dateStyle: 'medium', timeStyle: 'short' }))} · ${escapeHtml(DREAM_KIND_LABELS[entry.kind] || entry.kind)}</small>
      ${entry.added.map(item => `<span><b>Added:</b> ${escapeHtml(item.text)}</span>`).join('')}
      ${entry.retired.map(item => `<span><b>Marked as resolved:</b> ${escapeHtml(item.text)}${item.reason ? ` — ${escapeHtml(item.reason)}` : ''}</span>`).join('')}
      ${entry.added.length || entry.retired.length ? '' : '<span>Portrait rewritten, memory unchanged.</span>'}
      <div class="proposal-actions"><button type="button" data-dream-undo="${escapeHtml(entry.id)}">Undo this reflection</button></div>
    </article>`).join('')}</section>` : '';
  renderDreamChip();
}

function dreamCoverageLabel(covers = {}) {
  if (covers.availableConversations == null) return 'Text coverage not measured for this portrait';
  const partial = !covers.complete || covers.sourceCoverage?.some(source => !source.complete || (source.collection && source.collection.complete !== true));
  const missing = (covers.unavailableSources || []).map(key => DREAM_SOURCE_LABELS[key] || key);
  const collected = (covers.sourceCoverage || []).filter(source => source.collection).map(source =>
    `${DREAM_SOURCE_LABELS[source.key] || source.key}: ${source.collection.collectedItems ?? '?'}/${source.collection.availableItems ?? '?'} collected${source.collection.complete === true ? '' : ' (collection incomplete or unknown)'}`);
  return `${covers.conversations}/${covers.availableConversations} sessions read · ${covers.messages}/${covers.availableMessages} messages · ${partial ? 'partial coverage' : 'full session text'}${collected.length ? ` · ${collected.join(' · ')}` : ''}${missing.length ? ` · unavailable sources: ${missing.join(', ')}` : ''}`;
}

async function pollDream(epoch = dream.epoch) {
  // A newer watch replaces this one, so a click never leaves two polling chains.
  if (epoch !== dream.epoch) return;
  try {
    const previous = dream.status;
    dream.status = await api('/api/psyx/dream/status', { cache: 'no-store' });
    // A reflection finished since the last look: its portrait and memory changes are in the state.
    if (previous && dream.status.completedAt !== previous.completedAt) await loadPsyXState();
    else renderPortrait();
  } catch (error) {

  }
  if (epoch !== dream.epoch) return;
  dream.timer = setTimeout(() => void pollDream(epoch), dream.status?.status === 'running' ? 5000 : DREAM_POLL_MS);
}

function watchDream() {
  if (state.conversationFeatures?.dreamEnabled === false) { stopDreamWatch(); renderPortrait(); return; }
  clearTimeout(dream.timer);
  dream.epoch = (dream.epoch || 0) + 1;
  void pollDream();
}

function stopDreamWatch() {
  clearTimeout(dream.timer);
  dream.epoch = (dream.epoch || 0) + 1;
  dream.timer = null;
  dream.status = null;
}

async function dreamAction(button, request) {
  button.disabled = true;
  try {
    const result = await request();
    if (result?.state) { state.psyxState = result.state; renderPsyXState(); }
  } catch (error) {

    $('portraitMeta').textContent = error.status === 404 ? 'Already done.' : error.message;
    await loadPsyXState().catch(() => {});
  } finally { button.disabled = false; renderPortrait(); }
}

function wireDream() {
  $('dreamStatus').addEventListener('click', () => {
    activateStateTab($('tabUnderstanding'));
    if (drawerMode()) openDrawer('insights');
    markDreamSeen();
  });
  $('tabUnderstanding').addEventListener('click', markDreamSeen);
  $('dreamNow').addEventListener('click', event => dreamAction(event.currentTarget, async () => {
    await api('/api/psyx/dream/run', { method: 'POST' });
    dream.status = { ...dream.status, status: 'running' };
    renderPortrait();
    watchDream();
  }));
  $('portraitView').addEventListener('click', async event => {
    const open = event.target.closest('[data-evidence-session]');
    if (open) {
      const preview = open.nextElementSibling;
      if (preview.textContent) { preview.hidden = !preview.hidden; return; }
      open.disabled = true;
      try {
        const session = await api(`/api/psyx/sessions/${encodeURIComponent(open.dataset.evidenceSession)}`);
        const message = session.messages?.[Number(open.dataset.evidenceIndex)];
        if (message?.role !== 'user' || typeof message.content !== 'string'
            || !message.content.normalize('NFC').includes(open.dataset.evidenceQuote)) throw new Error('Source unavailable');
        preview.textContent = message.content;
      } catch (error) {
        preview.textContent = 'The source message is no longer available or has changed.';
      } finally { open.disabled = false; preview.hidden = false; }
      return;
    }
    const button = event.target.closest('[data-portrait-reject]');
    if (button) void dreamAction(button, () => api(`/api/psyx/portrait/statements/${encodeURIComponent(button.dataset.portraitReject)}`, { method: 'DELETE' }));
  });
  $('dreamLog').addEventListener('click', event => {
    const button = event.target.closest('[data-dream-undo]');
    if (button) void dreamAction(button, () => api(`/api/psyx/dream/${encodeURIComponent(button.dataset.dreamUndo)}/undo`, { method: 'POST' }));
  });
}
