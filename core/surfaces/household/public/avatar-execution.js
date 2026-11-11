/* Read-only scene attribution. Configuration alone never attests a reply model.
   On the full-screen face a badge names who wrote the last reply (Big Brain, Gardien, a
   fallback model or an automatic notice); a tap opens the detail and the requests the
   conversation still follows. Nothing is shown before a turn reports its execution. */
(function (root) {
  'use strict';
  const text = (value, limit = 160) => typeof value === 'string' ? value.slice(0, limit) : '';
  const REASONS = {
    hermes_active: 'Big Brain poursuit la demande précédente', primary_busy: 'Big Brain traite une autre demande',
    benchmark_claim: 'Ressources réservées à Benchmark', session_hold: 'Ressources réservées',
    quarantined: 'Moteur en attente de récupération', host_down: 'Big Brain injoignable',
    admission_blocked: 'Accès aux ressources momentanément refusé'
  };
  const OPEN_STATES = ['queued', 'dispatching', 'running', 'uncertain'];
  const STATE_WORDS = { queued: 'en attente', dispatching: 'démarrage', running: 'en cours', uncertain: 'issue non confirmée' };
  const BADGE = {
    brain: { label: 'Big Brain', icon: '<circle cx="12" cy="12" r="4.5"/><path d="M12 2.5v3M12 18.5v3M2.5 12h3M18.5 12h3M5.3 5.3l2.1 2.1M16.6 16.6l2.1 2.1M5.3 18.7l2.1-2.1M16.6 7.4l2.1-2.1"/>' },
    guardian: { label: 'Gardien', icon: '<path d="M12 2.8l7.5 3v5.6c0 4.7-3.2 8.4-7.5 9.8-4.3-1.4-7.5-5.1-7.5-9.8V5.8z"/><path d="M8.8 12.2l2.2 2.2 4.2-4.6"/>' },
    fallback: { label: 'Modèle de repli', icon: '<path d="M4 12a8 8 0 1 0 2.4-5.7"/><path d="M4 4v4.5h4.5"/>' },
    status: { label: 'Avis automatique', icon: '<rect x="4" y="5" width="16" height="12" rx="2"/><path d="M8 21h8M12 17v4"/>' },
    pending: { label: 'Réponse en cours', icon: '<circle cx="6" cy="12" r="1.4"/><circle cx="12" cy="12" r="1.4"/><circle cx="18" cy="12" r="1.4"/>' }
  };

  // Who wrote a reply, from its execution evidence only.
  function classify(data) {
    if (!data) return null;
    const tools = data.tools || data.toolEvidence;
    const relay = tools?.conversationRelay;
    const continuity = data.execution?.continuity;
    const source = text(data.routing?.source || data.routingSource);
    const model = text(data.execution?.model || (typeof data.model === 'string' ? data.model : data.model?.model));
    if (model === 'agentx-status' || continuity?.state === 'status_only') return { role: 'status' };
    if (!model) return { role: 'pending' };
    const guardian = continuity?.state === 'backup' || relay?.role === 'relay' || source === 'conversation_continuity'
      || tools?.authority === 'core.conversation-works';
    const fallback = data.routing?.fallbackUsed === true || data.fallbackUsed === true;
    const reason = continuity?.reason || (data.routing?.fallbackReason || data.fallbackReason)?.replace(/^task_fallback_/, '');
    const engine = text(data.execution?.backend || data.routing?.backend) || (source.startsWith('hermes/') ? 'hermes' : '');
    return {
      role: guardian ? 'guardian' : fallback ? 'fallback' : 'brain', model,
      limited: guardian && !!(relay || continuity?.contextReduced || continuity?.state === 'backup'),
      reason: guardian || fallback ? REASONS[reason] || 'Motif du relais non précisé' : '',
      engine: ({ hermes: 'Hermes', openclaw: 'OpenClaw', agentx: 'AgentX' })[engine] || ''
    };
  }
  function describe(data, completed = true) {
    const view = classify(data);
    if (!view) return '';
    if (view.role === 'status') return 'Message automatique d’AgentX · aucun modèle n’a rédigé cet avis';
    if (view.role === 'pending') return 'Modèle en attente de confirmation';
    return [completed ? 'Dernière réponse' : 'Réponse en cours',
      view.role === 'guardian' ? 'Gardien' + (view.limited ? ' · contexte limité' : '') : view.role === 'fallback' ? 'Modèle de repli' : 'Big Brain',
      view.model, view.reason || view.engine].filter(Boolean).join(' · ');
  }
  // The requests the conversation still follows (Big Brain's pending work), observed only.
  function openWorks(data) {
    if (!data || data.stale) return [];
    return (data.works || data.turns?.flatMap(row => row.works || []) || []).filter(row => OPEN_STATES.includes(row.state))
      .map(row => ({ text: text(row.requestText, 120) || 'Demande conservée', state: row.state, words: STATE_WORDS[row.state] }));
  }
  function workText(data) {
    if (data?.stale) return 'Suivi du travail indisponible';
    return openWorks(data).slice(0, 2).map(row => row.text + ' · ' + row.words).join(' / ');
  }

  function mount({ space, documentRef = root.document } = {}) {
    const doc = documentRef;
    const host = doc.createElement('div');
    host.className = 'avatar-scene-brain';
    host.hidden = true;
    const panelId = 'avatarSceneBrainPanel-' + (space || 'personal');
    host.innerHTML = `<button type="button" class="avatar-scene-brain-badge" aria-expanded="false" aria-controls="${panelId}">
        <svg viewBox="0 0 24 24" aria-hidden="true"></svg><span class="avatar-scene-brain-label"></span><span class="avatar-scene-brain-count" hidden></span></button>
      <section class="avatar-scene-brain-panel" id="${panelId}" aria-label="Qui répond" hidden>
        <p class="avatar-scene-execution"></p>
        <h2 class="avatar-scene-brain-title">Demandes suivies</h2>
        <ul class="avatar-scene-brain-works"></ul>
        <p class="avatar-scene-brain-empty"></p>
      </section>
      <p class="avatar-scene-brain-live sr-only" role="status" aria-live="polite"></p>`;
    const badge = host.querySelector('.avatar-scene-brain-badge');
    const icon = badge.querySelector('svg');
    const label = badge.querySelector('.avatar-scene-brain-label');
    const count = badge.querySelector('.avatar-scene-brain-count');
    const panel = host.querySelector('.avatar-scene-brain-panel');
    const line = host.querySelector('.avatar-scene-execution');
    const list = host.querySelector('.avatar-scene-brain-works');
    const empty = host.querySelector('.avatar-scene-brain-empty');
    const live = host.querySelector('[role=status]');
    const title = host.querySelector('.avatar-scene-brain-title');
    // tracked: this space reports followed requests (Super Dad); Famille never claims an empty list.
    let role = null, execution = '', works = [], stale = false, tracked = false, shownRole = null;

    const setOpen = open => { panel.hidden = !open; badge.setAttribute('aria-expanded', String(open)); };
    const render = () => {
      host.hidden = !role;
      host.dataset.role = role || '';
      if (!role) setOpen(false);
      const look = BADGE[role] || BADGE.pending;
      if (shownRole !== role) { icon.innerHTML = look.icon; shownRole = role; }
      label.textContent = look.label;
      count.textContent = String(works.length);
      count.hidden = !works.length;
      badge.title = execution || look.label;
      line.textContent = execution;
      line.hidden = !execution;
      list.replaceChildren(...works.map(row => {
        const item = doc.createElement('li');
        item.dataset.state = row.state;
        const what = doc.createElement('span'); what.textContent = row.text;
        const when = doc.createElement('small'); when.textContent = row.words;
        item.append(what, when);
        return item;
      }));
      title.hidden = !tracked;
      empty.textContent = !tracked ? '' : stale ? 'Suivi du travail indisponible' : works.length ? '' : 'Aucune demande en attente de Big Brain.';
      empty.hidden = !empty.textContent;
      const said = [execution, workText({ works, stale })].filter(Boolean).join(' — ');
      if (live.textContent !== said) live.textContent = said;
    };
    const activity = event => {
      const detail = event.detail || {};
      if (detail.space !== space) return;
      if (detail.kind === 'turn') { role = 'pending'; execution = 'Réponse en cours · modèle en attente de confirmation'; }
      if (detail.kind === 'execution') {
        role = classify(detail.data)?.role || role;
        execution = describe(detail.data, detail.completed !== false);
      }
      if (detail.kind === 'execution-interrupted') { role = role || 'pending'; execution = 'Réponse interrompue · exécution non confirmée'; }
      if (detail.kind === 'work') {
        tracked = true;
        stale = detail.data?.stale === true;
        works = openWorks(detail.data);
        if (works.length && !role) role = 'pending';
      }
      if (detail.kind === 'clear') { role = null; execution = ''; works = []; stale = false; }
      render();
    };
    const toggle = () => setOpen(panel.hidden);
    const outside = event => { if (!panel.hidden && !host.contains(event.target)) setOpen(false); };
    const onKey = event => { if (event.key === 'Escape' && !panel.hidden) { setOpen(false); badge.focus(); } };
    badge.addEventListener('click', toggle);
    doc.addEventListener('click', outside);
    doc.addEventListener('keydown', onKey);
    render(); doc.body.append(host); root.addEventListener('persona-activity', activity);
    return {
      dispose() {
        root.removeEventListener('persona-activity', activity);
        doc.removeEventListener('click', outside);
        doc.removeEventListener('keydown', onKey);
        host.remove();
      }
    };
  }
  const api = { classify, describe, openWorks, workText, mount };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.AvatarExecution = api;
})(typeof window === 'undefined' ? globalThis : window);
