(function () {
  'use strict';
  const $ = id => document.getElementById(id);
  const labels = { queued: 'En attente', in_progress: 'En cours', review: 'À revoir', blocked: 'Bloqué', done: 'Terminé' };
  const reasons = { no_useful_progress: 'Arrêt faute d’avancée utile', model_budget_reserve: 'Réserve du budget modèle atteinte',
    model_call_limit: 'Nombre maximal d’appels modèle atteint', hard_budget: 'Budget maximal atteint', tests_failed: 'Tests échoués',
    operator_stop: 'Arrêt demandé par l’opérateur', queue_window_closed: 'Créneau de travail terminé',
    worker_exit: 'Worker terminé', runner_error: 'Erreur du programme d’exécution', no_changes: 'Aucune modification produite',
    authorization_removed: 'Autorisation retirée', model_termination_unverified: 'Fin de l’appel modèle non confirmée' };
  const counters = { workSeconds: ['Travail', 's'], modelSeconds: ['Compteur modèle', 's'], modelCalls: ['Appels modèle', ''],
    testSeconds: ['Tests', 's'], ciSeconds: ['CI', 's'], maxResumes: ['Reprises', ''] };
  let extended = false;
  let offset = 0, selected = null, listVersion = 0, dossierVersion = 0;
  function node(tag, text, className) {
    const element = document.createElement(tag);
    if (text !== undefined) element.textContent = text;
    if (className) element.className = className;
    return element;
  }
  const date = value => value ? new Date(value).toLocaleString('fr-CA') : 'Non consigné';
  async function read(path) {
    const response = await fetch(path, { cache: 'no-store', signal: AbortSignal.timeout(20000) });
    const body = await response.json();
    if (!response.ok || !body.ok) throw new Error(body.error?.message || body.message || 'Lecture indisponible. Réessaie avec Actualiser.');
    return body.data;
  }
  function link(text, path) {
    const element = node('a', text); element.href = path; element.target = '_blank'; element.rel = 'noopener noreferrer'; return element;
  }
  function details(title, text, open = false) {
    const element = node('details'); element.open = open;
    element.append(node('summary', title), node('pre', text)); return element;
  }
  function usage(values) {
    const list = node('dl');
    for (const [key, [label, unit]] of Object.entries(counters)) if (Number.isFinite(values?.[key])) {
      list.append(node('dt', label), node('dd', `${values[key]} ${unit}`.trim()));
    }
    return list;
  }
  async function loadList(more = false) {
    const version = ++listVersion;
    if (!more) offset = 0;
    extended = more;
    const input = new FormData($('workFilters'));
    const query = new URLSearchParams({ limit: '30', offset: String(offset) });
    for (const key of ['query', 'status']) if (input.get(key)) query.set(key, input.get(key));
    $('workStatus').textContent = 'Lecture de Core…'; $('workMore').disabled = true;
    try {
      const data = await read('/api/pipeline/work?' + query);
      if (version !== listVersion) return;
      if (!more) $('workList').replaceChildren();
      for (const task of data.tasks) {
        const button = node('button', undefined, 'work-card'); button.type = 'button'; button.dataset.task = task.pipelineId;
        button.setAttribute('aria-pressed', String(task.pipelineId === selected));
        button.append(node('strong', '#' + task.pipelineId + ' · ' + task.title), node('span', labels[task.status] || task.status, 'badge'),
          node('small', (task.assignee || 'Exécutant non attribué') + ' · ' + date(task.updatedAt)),
          node('small', task.nextAction?.detail || 'Ouvre le dossier pour lire les preuves.'));
        button.addEventListener('click', () => loadDossier(task.pipelineId)); $('workList').append(button);
      }
      offset = data.nextOffset;
      $('workMore').hidden = !data.hasMore;
      $('workStatus').textContent = `${$('workList').childElementCount} dossier(s) affiché(s) sur ${data.total} · relevé ${new Date().toLocaleTimeString('fr-CA')}`;
      if (!data.total) $('workList').append(node('p', 'Aucun dossier ne correspond à cette recherche.'));
    } catch (error) {
      if (version !== listVersion) return;
      $('workStatus').textContent = 'Lecture indisponible : ' + error.message + ' Les données déjà affichées peuvent être anciennes.';
    } finally { if (version === listVersion) $('workMore').disabled = false; }
  }
  async function loadDossier(id) {
    const version = ++dossierVersion; selected = id;
    for (const card of $('workList').querySelectorAll('button')) card.setAttribute('aria-pressed', String(card.dataset.task === id));
    const pane = $('workDossier'); pane.replaceChildren(node('p', 'Lecture du dossier complet…'));
    try {
      let page = await read(`/api/pipeline/tasks/${id}/dossier`);
      const summary = page.task, hash = page.contentHash;
      let text = page.text;
      while (page.hasMore) {
        if (version !== dossierVersion) return;
        page = await read(`/api/pipeline/tasks/${id}/dossier?offset=${page.nextOffset}&expectedHash=${hash}`);
        if (page.contentHash !== hash) throw new Error('Le dossier a changé. Ouvre-le de nouveau.');
        text += page.text;
      }
      const dossier = JSON.parse(text);
      if (version !== dossierVersion) return;
      pane.replaceChildren(node('span', labels[dossier.task.status] || dossier.task.status, 'badge'),
        node('h2', `#${id} · ${dossier.task.title}`), link('Ouvrir dans le Pipeline ↗', `/pipeline?task=${id}`));
      pane.append(node('p', summary.nextAction?.detail || 'Consulte les preuves consignées.', 'notice'));
      pane.append(details('Demande et critères de réussite', dossier.task.spec || 'Aucune consigne consignée.', true));
      const execution = dossier.execution;
      pane.append(node('h3', 'Exécution et limites'));
      if (execution) {
        pane.append(node('p', `État technique : ${execution.state || 'inconnu'} · ${reasons[execution.reason] || execution.reason || 'sans motif consigné'}`));
        pane.append(node('p', 'Dernière avancée utile consignée : ' + date(execution.lastUsefulProgressAt)));
        const budget = node('details'); budget.append(node('summary', 'Budget total et solde après les essais terminés'),
          node('h3', 'Plafonds cumulés'), usage(execution.limits), node('h3', 'Solde consigné'), usage(execution.remaining)); pane.append(budget);
        pane.append(node('p', 'Un budget restant ne constitue pas une autorisation de reprise. Les compteurs sont ceux du travail enregistré, pas une mesure de temps GPU.'));
        if (execution.scope.length) pane.append(details('Fichiers autorisés', execution.scope.join('\n')));
        for (const run of [...execution.runs].reverse()) {
          const block = node('section', undefined, 'receipt');
          block.append(node('strong', `${run.result || (run.finishedAt ? 'Résultat non consigné' : 'Résultat en attente')} · ${run.executorId || 'Exécutant non consigné'}`),
            node('p', `${date(run.startedAt)} → ${run.finishedAt ? date(run.finishedAt) : 'Fin non consignée'}`),
            node('p', `Requête : ${run.requestId} · inférences non résolues : ${run.pendingInferenceCount}`));
          if (run.usage) block.append(usage(run.usage));
          pane.append(block);
        }
        if (execution.manualInterventions.length) pane.append(details('Interventions opérateur consignées', JSON.stringify(execution.manualInterventions, null, 2)));
      } else pane.append(node('p', 'Aucun suivi autonome enregistré. Les comptes rendus ci-dessous peuvent documenter un travail réalisé en session interactive.'));
      pane.append(node('h3', 'Comptes rendus et preuves citées'));
      if (!dossier.feedback.length) pane.append(node('p', 'Aucun compte rendu consigné.'));
      for (const entry of [...dossier.feedback].reverse()) {
        const report = details(`${date(entry.at)} · ${entry.by || 'Auteur non consigné'}`, entry.text, true);
        for (const value of new Set(entry.text.match(/https:\/\/[^\s<>"`]+/g) || [])) {
          try {
            const url = new URL(value.replace(/[),.;]+$/, ''));
            if (url.username || url.password) continue;
            const paragraph = node('p'); paragraph.append(link(url.hostname + url.pathname, url.href)); report.append(paragraph);
          } catch { /* Malformed reference remains visible as original text. */ }
        }
        pane.append(report);
      }
      if (dossier.attempts.length) pane.append(details('Tests et décisions des tentatives', JSON.stringify(dossier.attempts, null, 2)));
      const artifacts = await read(`/api/pipeline/tasks/${id}/deliverables`);
      if (version !== dossierVersion) return;
      pane.append(node('h3', 'Livrables enregistrés'));
      if (!artifacts.deliverables.length) pane.append(node('p', 'Le registre est vide. Les comptes rendus et leurs liens peuvent néanmoins contenir des preuves de travail.'));
      for (const artifact of artifacts.deliverables) {
        const block = node('p'); block.append(link(artifact.name, `/api/pipeline/tasks/${id}/deliverables/${artifact.id}/download`));
        block.append(node('small', ` · ${artifact.availability?.status || 'Disponibilité non vérifiée'}`)); pane.append(block);
      }
      pane.append(node('p', 'Les sessions isolées des workers ne sont pas des sessions Studio modifiables. Ce dossier donne accès au travail consigné; il ne prouve ni une installation ni une validation humaine.', 'notice'));
    } catch (error) {
      if (version === dossierVersion) pane.append(node('p', 'Lecture incomplète : ' + error.message + ' Ouvre de nouveau le dossier pour réessayer.', 'error'));
    }
  }
  $('workFilters').addEventListener('submit', event => { event.preventDefault(); loadList(); });
  $('workRefresh').addEventListener('click', () => { loadList(); if (selected) loadDossier(selected); });
  $('workMore').addEventListener('click', () => loadList(true));
  // Poll only the visible index. Reading a long report never loses its place.
  setInterval(() => { if (!document.hidden && !document.querySelector('#workFilters :focus') && !extended) loadList(); }, 30000);
  loadList();
})();
