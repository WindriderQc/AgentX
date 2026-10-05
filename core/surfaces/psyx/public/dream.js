'use strict';

// The portrait PsyX writes between sessions, and the trace of what each of
// those reflections changed in memory. PsyX writes directly; the user reads,
// removes what is not him, and can undo a whole reflection. Loaded before
// app.js, whose shared state and helpers these functions use at call time.

const PORTRAIT_TITLES = {
  situation: 'Ta situation', loops: 'Les boucles qui reviennent', triggers: 'Ce qui te déclenche', relationships: 'Tes relations',
  strengths: 'Tes forces', values: 'Ce qui compte pour toi', whatWorks: 'Ce qui marche pour toi', blindSpots: 'Angles morts possibles', health: 'Santé'
};
const DREAM_KIND_LABELS = { night: 'cette nuit', session: 'après ta séance', manual: 'à ta demande' };
const DREAM_SOURCE_LABELS = { notes: 'notes de Nestor', tasks: 'tâches et rappels', mail: 'journal de courriel' };
const INTAKE_LABELS = { currentSituation: 'ta situation actuelle', reasonsAndGoals: 'ce que tu cherches', familyOfOrigin: 'ta famille d’origine', relationships: 'tes relations',
  children: 'tes enfants', work: 'ton travail', physicalHealth: 'ta santé physique', sleep: 'ton sommeil', substances: 'alcool et substances', supports: 'tes appuis', pastHelp: 'l’aide déjà reçue' };
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
    ? 'PsyX approfondit ton portrait…'
    : `PsyX a approfondi ton portrait ${DREAM_KIND_LABELS[portrait?.kind] || ''}${findings ? ` · ${findings} constat${findings === 1 ? '' : 's'}` : ''}`;
  chip.title = 'Entre les séances, PsyX approfondit ce qu’il comprend de toi. Le portrait indique la couverture du texte analysé. Tu peux lire, retirer et annuler.';
  $('tabUnderstanding').dataset.badge = fresh && !running ? '•' : '';
}

function portraitList(title, items) {
  return items?.length ? `<section class="state-section"><h4>${escapeHtml(title)}</h4><ul class="portrait-list">${items.map(item => `<li>${escapeHtml(item.text || item)}${
    portraitEvidence(item)}</li>`).join('')}</ul></section>` : '';
}

function portraitEvidence(item) {
  const labels = { conversation: 'tes mots en séance', profile: 'ton profil', memory: 'ta mémoire',
    experiment: 'ton expérience enregistrée', checkIn: 'ton check-in', assessment: 'ton questionnaire calculé', ...DREAM_SOURCE_LABELS };
  return (item.evidence || []).map(quote => {
    const ref = (item.evidenceRefs || []).find(candidate => candidate.quote === quote);
    const source = ref ? `Citation retrouvée dans ${labels[ref.kind] || 'la source'}` : 'Ancienne citation : source non vérifiée';
    const open = ref?.kind === 'conversation' && /^[a-f0-9]{24}$/i.test(ref.conversationId || '') && Number.isSafeInteger(ref.messageIndex)
      ? `<button type="button" data-evidence-session="${escapeHtml(ref.conversationId)}" data-evidence-index="${ref.messageIndex}" data-evidence-quote="${escapeHtml(quote)}">Lire le message source</button><p class="portrait-source" hidden></p>` : '';
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
  return `<section class="state-section"><h4>Ce que PsyX connaît de ta vie</h4><p class="state-help">${known} domaine${known > 1 ? 's' : ''} sur ${domains.length} bien connu${known > 1 ? 's' : ''}${partial ? `, ${partial} en partie` : ''}.${
    missing.length ? ` Encore à découvrir, une question à la fois : ${escapeHtml(missing.join(', '))}.` : ''}</p></section>`;
}

function renderPortrait() {
  const portrait = state.psyxState?.portrait;
  const log = (state.psyxState?.dreamLog || []).filter(entry => !entry.undone && (entry.added.length || entry.retired.length || entry.id === portrait?.id)).slice(-5).reverse();
  const running = dream.status?.status === 'running';
  $('dreamNow').disabled = running || !dream.status?.enabled;
  $('dreamNow').textContent = running ? 'PsyX réfléchit…' : 'Approfondir maintenant';
  if (!portrait?.sections?.length) {
    $('portraitMeta').textContent = dream.status?.status === 'failed' ? 'La dernière réflexion n’a pas abouti. Elle sera reprise la nuit prochaine.' : '';
    $('portraitView').innerHTML = `<p class="state-empty">${running ? 'PsyX écrit ton portrait…' : state.conversationFeatures?.dreamEnabled === false ? 'Rêverie désactivée dans Contexte et performance.' : state.conversationFeatures?.automaticDream === false ? 'Pas encore de portrait. Tu peux demander une réflexion avec Approfondir maintenant.' : 'Pas encore de portrait. PsyX l’écrit après tes séances et chaque nuit, à partir du contexte disponible.'}</p>`;
  } else {
    const sources = (portrait.sources || []).map(key => DREAM_SOURCE_LABELS[key] || key);
    $('portraitMeta').textContent = [dream.status?.status === 'failed' ? 'La dernière réflexion n’a pas abouti' : null, `Écrit le ${new Date(portrait.updatedAt).toLocaleString('fr-CA', { dateStyle: 'long', timeStyle: 'short' })}`,
      dreamCoverageLabel(portrait.covers),
      sources.length ? `avec ${sources.join(', ')}` : null,
      portrait.location === 'frontier' ? 'réflexion infonuagique' : 'réflexion locale'].filter(Boolean).join(' · ');
    $('portraitView').innerHTML = portrait.sections.map(section => `<section class="state-section"><h4>${escapeHtml(PORTRAIT_TITLES[section.key] || section.key)}</h4>${section.statements.map(item => `
      <article class="proposal-card portrait-statement">
        <strong>${escapeHtml(item.text)}</strong>${Number.isFinite(item.confidence) ? `<small>confiance ${Math.round(item.confidence * 100)} %</small>` : ''}
        ${portraitEvidence(item)}
        <div class="proposal-actions"><button type="button" data-portrait-reject="${escapeHtml(item.id)}">Ce n’est pas moi</button></div>
      </article>`).join('')}</section>`).join('')
      + intakeSummary(portrait.intake)
      + portraitList('Ce que PsyX voit d’une séance à l’autre', portrait.findings)
      + portraitList('À explorer à la prochaine séance', portrait.agenda)
      + portraitList('Ce que PsyX aimerait mieux comprendre', portrait.questions);
  }
  $('dreamLog').innerHTML = log.length ? `<section class="state-section"><h4>Ce que ces réflexions ont changé en mémoire</h4>${log.map(entry => `
    <article class="proposal-card">
      <small>${escapeHtml(new Date(entry.at).toLocaleString('fr-CA', { dateStyle: 'medium', timeStyle: 'short' }))} · ${escapeHtml(DREAM_KIND_LABELS[entry.kind] || entry.kind)}</small>
      ${entry.added.map(item => `<span><b>Ajouté :</b> ${escapeHtml(item.text)}</span>`).join('')}
      ${entry.retired.map(item => `<span><b>Classé comme résolu :</b> ${escapeHtml(item.text)}${item.reason ? ` — ${escapeHtml(item.reason)}` : ''}</span>`).join('')}
      ${entry.added.length || entry.retired.length ? '' : '<span>Portrait réécrit, mémoire inchangée.</span>'}
      <div class="proposal-actions"><button type="button" data-dream-undo="${escapeHtml(entry.id)}">Annuler cette réflexion</button></div>
    </article>`).join('')}</section>` : '';
  renderDreamChip();
}

function dreamCoverageLabel(covers = {}) {
  if (covers.availableConversations == null) return 'Couverture du texte non mesurée pour ce portrait';
  const partial = !covers.complete || covers.sourceCoverage?.some(source => !source.complete);
  const missing = (covers.unavailableSources || []).map(key => DREAM_SOURCE_LABELS[key] || key);
  return `${covers.conversations}/${covers.availableConversations} séances consultées · ${covers.messages}/${covers.availableMessages} messages · ${partial ? 'couverture partielle' : 'texte des séances complet'}${missing.length ? ` · sources indisponibles : ${missing.join(', ')}` : ''}`;
}

async function pollDream(accessEpoch, epoch = dream.epoch) {
  // A newer watch replaces this one, so a click never leaves two polling chains.
  if (accessEpoch !== state.accessEpoch || !state.unlocked || epoch !== dream.epoch) return;
  try {
    const previous = dream.status;
    dream.status = await api('/api/psyx/dream/status', { cache: 'no-store' });
    // A reflection finished since the last look: its portrait and memory changes are in the state.
    if (previous && dream.status.completedAt !== previous.completedAt) await loadPsyXState();
    else renderPortrait();
  } catch (error) {
    if (error.code === 'PSYX_LOCKED') return;
  }
  if (accessEpoch !== state.accessEpoch || epoch !== dream.epoch) return;
  dream.timer = setTimeout(() => void pollDream(accessEpoch, epoch), dream.status?.status === 'running' ? 5000 : DREAM_POLL_MS);
}

function watchDream() {
  if (state.conversationFeatures?.dreamEnabled === false) { stopDreamWatch(); renderPortrait(); return; }
  clearTimeout(dream.timer);
  dream.epoch = (dream.epoch || 0) + 1;
  void pollDream(state.accessEpoch);
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
    if (error.code === 'PSYX_LOCKED') return;
    $('portraitMeta').textContent = error.status === 404 ? 'Déjà fait.' : error.message;
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
        if (error.code !== 'PSYX_LOCKED') preview.textContent = 'Le message source n’est plus disponible ou a changé.';
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
