/* Read-only scene attribution. Configuration alone never attests a reply model. */
(function (root) {
  'use strict';
  const text = (value, limit = 160) => typeof value === 'string' ? value.slice(0, limit) : '';
  const REASONS = {
    hermes_active: 'Big Brain poursuit la demande précédente', primary_busy: 'Big Brain traite une autre demande',
    benchmark_claim: 'Ressources réservées à Benchmark', session_hold: 'Ressources réservées',
    quarantined: 'Moteur en attente de récupération', host_down: 'Big Brain injoignable',
    admission_blocked: 'Accès aux ressources momentanément refusé'
  };
  function describe(data, completed = true) {
    if (!data) return '';
    const tools = data.tools || data.toolEvidence;
    const relay = tools?.conversationRelay;
    const continuity = data.execution?.continuity;
    const source = text(data.routing?.source || data.routingSource);
    const model = text(data.execution?.model || (typeof data.model === 'string' ? data.model : data.model?.model));
    if (model === 'agentx-status' || continuity?.state === 'status_only') return 'État du service · aucun modèle ne répond';
    if (!model) return 'Modèle en attente de confirmation';
    const guardian = continuity?.state === 'backup' || relay?.role === 'relay' || source === 'conversation_continuity'
      || tools?.authority === 'core.conversation-works';
    const fallback = data.routing?.fallbackUsed === true || data.fallbackUsed === true;
    const reason = continuity?.reason || (data.routing?.fallbackReason || data.fallbackReason)?.replace(/^task_fallback_/, '');
    const engine = text(data.execution?.backend || data.routing?.backend) || (source.startsWith('hermes/') ? 'hermes' : '');
    return [completed ? 'Dernière réponse' : 'Réponse en cours', guardian ? 'Gardien' + (relay || continuity?.contextReduced || continuity?.state === 'backup' ? ' · contexte limité' : '') : fallback ? 'Modèle de repli' : 'Big Brain', model,
      guardian || fallback ? REASONS[reason] || 'Motif du relais non précisé' : ({ hermes: 'Hermes', openclaw: 'OpenClaw', agentx: 'AgentX' })[engine]].filter(Boolean).join(' · ');
  }
  function workText(data) {
    if (data?.stale) return 'Suivi du travail indisponible';
    return (data?.works || data?.turns?.flatMap(row => row.works || []) || []).filter(row => ['queued', 'dispatching', 'running', 'uncertain'].includes(row.state)).slice(0, 2)
      .map(row => [text(row.requestText, 120) || 'Demande conservée',
        ({ queued: 'en attente', dispatching: 'démarrage', running: 'en cours', uncertain: 'issue non confirmée' })[row.state]].join(' · ')).join(' / ');
  }
  function mount({ container, space, documentRef = root.document }) {
    const line = documentRef.createElement('p'); line.className = 'avatar-scene-execution';
    line.setAttribute('role', 'status'); line.setAttribute('aria-live', 'polite');
    let execution = '', work = '';
    const render = () => { line.textContent = [execution, work].filter(Boolean).join(' — '); line.hidden = !line.textContent; };
    const activity = event => {
      const detail = event.detail || {};
      if (detail.space !== space) return;
      if (detail.kind === 'turn') execution = 'Réponse en cours · modèle en attente de confirmation';
      if (detail.kind === 'execution') execution = describe(detail.data, detail.completed !== false);
      if (detail.kind === 'execution-interrupted') execution = 'Réponse interrompue · exécution non confirmée';
      if (detail.kind === 'work') work = workText(detail.data);
      if (detail.kind === 'clear') { execution = ''; work = ''; }
      render();
    };
    render(); container.append(line); root.addEventListener('persona-activity', activity);
    return { dispose() { root.removeEventListener('persona-activity', activity); line.remove(); } };
  }
  const api = { describe, workText, mount };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.AvatarExecution = api;
})(typeof window === 'undefined' ? globalThis : window);
