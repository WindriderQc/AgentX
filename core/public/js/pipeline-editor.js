(function () {
  'use strict';
  const $ = id => document.getElementById(id);
  const fields = { title: 'pipelineEditTitle', spec: 'pipelineEditSpec', service: 'pipelineEditService', priority: 'pipelineEditPriority', dependsOn: 'pipelineEditDependencies', dueAt: 'pipelineEditDue', notBefore: 'pipelineEditNotBefore', planningItemIds: 'pipelineEditRoadmap', epic: 'pipelineEditEpic' };
  const services = {
    core: 'Interfaces AgentX, conversations, tâches et routage des modèles.',
    benchmark: 'Évaluation des modèles, scores et Profiler.',
    rag: 'Documents, indexation et recherche de connaissances.',
    data: 'Inventaire, collecteurs et télémétrie.',
    ecosystem: 'Intégrations et coordination entre composants.'
  };
  let dialog, form, current = null, baseline = {}, token = null, sourceKey = '', saving = false;
  let drafting = null, proposal = null, latest = null, generation = 0;

  async function api(url, options = {}) {
    const response = await fetch(url, { ...options, headers: { 'Content-Type': 'application/json', ...options.headers } });
    const body = await response.json();
    if (!response.ok || body.ok === false) throw Object.assign(new Error(body.message || 'La requête a échoué'), { status: response.status, code: body.code });
    return body.data;
  }
  function status(message, error = false) {
    $('pipelineEditorStatus').textContent = message;
    $('pipelineEditorStatus').dataset.error = String(error);
  }
  function localDate(value) {
    if (!value) return '';
    const date = new Date(value);
    return new Date(date.getTime() - date.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
  }
  function values() {
    return {
      title: $(fields.title).value.trim(), spec: $(fields.spec).value,
      service: $(fields.service).value.trim(), priority: Number($(fields.priority).value), epic: $(fields.epic).value.trim(),
      dependsOn: [...new Set($(fields.dependsOn).value.split(/[\s,]+/).filter(Boolean))],
      dueAt: $(fields.dueAt).value ? new Date($(fields.dueAt).value).toISOString() : null,
      notBefore: $(fields.notBefore).value ? new Date($(fields.notBefore).value).toISOString() : null,
      planningItemIds: [...$(fields.planningItemIds).selectedOptions].map(option => option.value).sort()
    };
  }
  function different(a, b) { return JSON.stringify(a) !== JSON.stringify(b); }
  function dirty() { return different(values(), baseline); }
  function archivedLabel(value) { return ['aiops', 'agentxecosystem'].includes(value.toLowerCase().replace(/[\s_-]/g, '')); }
  function updateGuidance() {
    const value = values();
    const service = value.service.toLowerCase();
    const privateService = ['personal', 'family', 'household', 'secretary'].includes(service);
    $('pipelineServiceHelp').textContent = !service
      ? 'Quel composant est concerné? Vide = service non précisé. Vous pourrez le choisir plus tard.'
      : archivedLabel(service)
        ? 'Cette étiquette vient d’un projet archivé. Elle reste lisible dans l’historique. Pour une nouvelle tâche AgentX, choisissez le composant actuel ou laissez vide.'
        : privateService
          ? 'Ce service place la tâche dans le suivi personnel ou familial. Elle sera exclue de la vue ingénierie de Pipeline.'
          : Object.hasOwn(services, service) ? services[service] : 'Étiquette personnalisée pour classer et filtrer les tâches. Vous pouvez garder ce nom ou laisser vide.';
    const schedule = value.notBefore ? `Disponible au plus tôt le ${new Date(value.notBefore).toLocaleString('fr-CA')}` : 'Disponible dès l’enregistrement';
    const dependencies = value.dependsOn.length ? `après la fin de ${value.dependsOn.length} tâche(s) liée(s)` : 'sans dépendance';
    const deadline = value.dueAt ? `Échéance souhaitée : ${new Date(value.dueAt).toLocaleString('fr-CA')}.` : 'Sans échéance.';
    const classification = `Service : ${value.service || 'non précisé'} · Groupe : ${value.epic.trim() || 'sans groupe'} · Priorité : P${value.priority}.`;
    $('pipelineSavePreviewHeading').textContent = current ? 'Effet des modifications' : 'Après la création';
    $('pipelineSavePreview').textContent = current
      ? `${classification} ${deadline} L’état, le responsable et l’historique actuels sont conservés.`
      : `${classification} ${schedule}, ${dependencies}. ${deadline} ${privateService ? 'La tâche apparaît dans le suivi personnel ou familial, selon ses règles propres.' : 'La demande apparaît dans Pipeline comme proposition à trier. Son acceptation et son autorisation d’exécution restent séparées.'} Ce bouton ne lance pas un agent.`;
  }
  function setRoadmap(items = [], selected = []) {
    const select = $(fields.planningItemIds);
    select.replaceChildren();
    const available = new Map(items.map(item => [String(item.id || item._id), `${item.type} · ${item.title}`]));
    for (const id of selected) if (!available.has(String(id))) available.set(String(id), `Objectif lié · ${id}`);
    for (const [id, title] of available) select.add(new Option(title, id, false, selected.map(String).includes(id)));
  }
  function fill(task = {}) {
    for (const key of ['title', 'spec', 'service', 'epic']) $(fields[key]).value = task[key] || '';
    $(fields.priority).value = task.priority || 3;
    $(fields.dependsOn).value = (task.dependsOn || []).join(', ');
    $(fields.dueAt).value = localDate(task.dueAt);
    $(fields.notBefore).value = localDate(task.notBefore);
    setRoadmap([], task.planningItemIds || []);
    baseline = values();
    updateGuidance();
  }
  function stopDraft(message = '') {
    generation += 1;
    drafting?.abort(); drafting = null; proposal = null;
    $('pipelineDraftGenerate').disabled = saving;
    $('pipelineDraftCancel').hidden = true;
    $('pipelineDraftProposal').hidden = true;
    if (message) $('pipelineDraftStatus').textContent = message;
  }
  function close() {
    stopDraft();
    dialog.close();
  }
  function requestClose() {
    if (saving) return;
    if (dirty()) {
      $('pipelineEditorDiscard').hidden = false;
      $('pipelineEditorDiscard').scrollIntoView({ block: 'nearest' });
      $('pipelineDiscardCancel').focus();
    } else close();
  }
  async function loadRoadmap() {
    const openGeneration = sourceKey;
    try {
      const data = await api('/api/planning/items');
      if (sourceKey !== openGeneration) return;
      // Do not change selections made while the option list was loading.
      const nowSelected = [...$(fields.planningItemIds).selectedOptions].map(option => option.value);
      setRoadmap(data.items || [], nowSelected);
      $('pipelineRoadmapStatus').textContent = data.items?.length ? 'Reliez la tâche à un objectif existant. Ctrl/Cmd permet plusieurs sélections; Ctrl/Cmd + clic retire un lien. Sans sélection, aucun lien n’est ajouté.' : 'Aucun objectif à relier. Planning est une référence historique; laissez ce champ vide.';
    } catch {
      if (sourceKey !== openGeneration) return;
      $('pipelineRoadmapStatus').textContent = 'Planning est indisponible. Les liens existants sont conservés; les autres champs peuvent être enregistrés.';
    }
  }
  async function open(pipelineId, tasks = []) {
    stopDraft(); current = null; latest = null; token = null; saving = false;
    sourceKey = Array.from(crypto.getRandomValues(new Uint32Array(4)), n => n.toString(16)).join('-');
    const opening = sourceKey;
    form.reset(); fill();
    for (const id of ['pipelineEditorDetails', 'pipelineEditorAssist']) $(id).open = false;
    for (const id of ['pipelineEditorConflict', 'pipelineEditorDiscard', 'pipelineDraftProposal']) $(id).hidden = true;
    $('pipelineDraftStatus').textContent = 'L’IA propose un texte; vous choisissez de l’utiliser avant d’enregistrer.';
    $('pipelineRoadmapStatus').textContent = 'Facultatif. Reliez la tâche à un objectif existant. Sans sélection, aucun lien n’est ajouté.';
    $('pipelineEditorHeading').textContent = pipelineId ? `Modifier la tâche #${pipelineId}` : 'Nouvelle tâche';
    $('pipelineEditorContext').textContent = pipelineId ? 'Chargement de la tâche…' : 'Un titre suffit pour commencer. Décrivez le résultat souhaité; le classement et la planification peuvent attendre.';
    $('pipelineEditorSave').textContent = pipelineId ? 'Enregistrer les modifications' : 'Créer la tâche';
    $('pipelineEditorSave').disabled = Boolean(pipelineId);
    dialog.querySelector('.pipeline-editor-body').inert = Boolean(pipelineId);
    $('pipelineServiceChoices').replaceChildren(...Object.entries(services).map(([service, explanation]) => new Option(`${service} · ${explanation}`, service)));
    $('pipelineEpicChoices').replaceChildren(...[...new Set(tasks.filter(task => task.status !== 'done').map(task => task.epic).filter(epic => epic && epic !== 'MCP Inbox' && !archivedLabel(epic)))].sort().map(epic => new Option(epic, epic)));
    status(''); dialog.showModal(); $(fields.title).focus();
    if (!pipelineId) return;
    try {
      const data = await api(`/api/pipeline/tasks/${encodeURIComponent(pipelineId)}`);
      if (sourceKey !== opening || !dialog.open) return;
      current = data.task; token = data.editToken; fill(current);
      if (current.service || current.epic || current.dueAt || current.notBefore || current.dependsOn?.length || current.planningItemIds?.length) $('pipelineEditorDetails').open = true;
      $('pipelineEditorContext').textContent = `${current.status.replace(/_/g, ' ')}${current.assignee ? ` · ${current.assignee}` : ''}. Les modifications conservent l’état, le responsable et l’historique.`;
      $('pipelineEditorSave').disabled = false;
      dialog.querySelector('.pipeline-editor-body').inert = false;
      $(fields.title).focus();
    } catch (error) { if (sourceKey === opening) status(`Chargement impossible : ${error.message}. Fermez puis rouvrez pour réessayer.`, true); }
  }
  async function compareLatest() {
    const data = await api(`/api/pipeline/tasks/${encodeURIComponent(current.pipelineId)}`);
    latest = data;
    const task = data.task;
    $('pipelineLatestTask').textContent = `${task.title}\n\n${task.spec || ''}\n\nService : ${task.service || 'non précisé'} · P${task.priority || 3}\nDépendances : ${(task.dependsOn || []).join(', ') || 'aucune'}\nÉchéance : ${task.dueAt || 'aucune'}\nDisponible après : ${task.notBefore || 'maintenant'}\nPlanning : ${(task.planningItemIds || []).join(', ') || 'aucun lien'}\nGroupe : ${task.epic || 'sans groupe'}`;
    $('pipelineEditorConflict').hidden = false;
    $('pipelineEditorSave').disabled = true;
    $('pipelineEditorConflict').scrollIntoView({ block: 'nearest' });
  }
  async function save(event) {
    event.preventDefault();
    if (saving || !form.reportValidity()) return;
    stopDraft(); saving = true; $('pipelineEditorSave').disabled = true; $('pipelineDraftGenerate').disabled = true;
    status('Enregistrement…');
    try {
      const input = values();
      let id;
      if (current) {
        const changes = Object.fromEntries(Object.entries(input).filter(([key, value]) => different(value, baseline[key])));
        const data = await api(`/api/pipeline/tasks/${encodeURIComponent(current.pipelineId)}`, { method: 'PATCH', body: JSON.stringify({ changes, editToken: token, by: 'operator' }) });
        id = data.task.pipelineId;
      } else {
        const data = await api('/api/pipeline/tasks', { method: 'POST', body: JSON.stringify({ ...input, source: 'pipeline-ui', sourceKey }) });
        id = data.task.pipelineId;
        if (data.task.alreadyExisting) {
          current = { pipelineId: id };
          updateGuidance();
          $('pipelineEditorHeading').textContent = `Modifier la tâche #${id}`;
          $('pipelineEditorSave').textContent = 'Enregistrer les modifications';
          await compareLatest();
          status('Une tentative précédente a créé cette tâche. Comparez la version enregistrée à votre brouillon avant de poursuivre.', true);
          return;
        }
      }
      close();
      document.dispatchEvent(new CustomEvent('pipeline-task-saved', { detail: { pipelineId: id } }));
    } catch (error) {
      status(error.message, true);
      if (error.code === 'TASK_EDIT_CONFLICT') await compareLatest().catch(() => status('La dernière version est indisponible. Votre brouillon est conservé; réessayez d’enregistrer.', true));
    } finally {
      saving = false;
      $('pipelineEditorSave').disabled = Boolean(latest);
      $('pipelineDraftGenerate').disabled = false;
    }
  }
  async function suggest() {
    const instruction = $('pipelineDraftInstruction').value.trim();
    if (!instruction) { $('pipelineDraftInstruction').focus(); $('pipelineDraftStatus').textContent = 'Décrivez d’abord votre idée ou le changement souhaité.'; return; }
    stopDraft(); const sequence = generation;
    drafting = new AbortController();
    $('pipelineDraftGenerate').disabled = true; $('pipelineDraftCancel').hidden = false;
    $('pipelineDraftStatus').textContent = 'Préparation d’un brouillon… Vous pouvez arrêter ou continuer à écrire.';
    const value = values();
    try {
      const data = await api('/api/pipeline/draft', { method: 'POST', signal: drafting.signal, body: JSON.stringify({ instruction, current: { title: value.title, spec: value.spec, service: value.service, priority: value.priority } }) });
      if (generation !== sequence || !dialog.open) return;
      proposal = data.draft;
      $('pipelineDraftTitle').textContent = proposal.title;
      $('pipelineDraftSpec').textContent = proposal.spec;
      $('pipelineDraftMeta').textContent = `${proposal.service || 'Service non précisé'} · P${proposal.priority}`;
      $('pipelineDraftProposal').hidden = false;
      $('pipelineDraftStatus').textContent = 'Relisez le brouillon. Rien n’est encore enregistré.';
    } catch (error) {
      if (generation === sequence) $('pipelineDraftStatus').textContent = error.name === 'AbortError' ? 'Arrêté. Votre texte est conservé.' : error.message;
    } finally {
      if (generation === sequence) { drafting = null; $('pipelineDraftGenerate').disabled = false; $('pipelineDraftCancel').hidden = true; }
    }
  }
  document.addEventListener('DOMContentLoaded', () => {
    dialog = $('pipelineTaskEditor'); form = $('pipelineEditorForm');
    if (!dialog) return;
    form.addEventListener('submit', save);
    dialog.addEventListener('cancel', event => { event.preventDefault(); requestClose(); });
    dialog.querySelectorAll('[data-editor-close]').forEach(button => button.addEventListener('click', requestClose));
    $('pipelineDiscardConfirm').addEventListener('click', close);
    $('pipelineDiscardCancel').addEventListener('click', () => { $('pipelineEditorDiscard').hidden = true; $(fields.spec).focus(); });
    $('pipelineEditorDetails').addEventListener('toggle', () => { if ($('pipelineEditorDetails').open) void loadRoadmap(); });
    $('pipelineDraftGenerate').addEventListener('click', suggest);
    $('pipelineDraftCancel').addEventListener('click', () => stopDraft('Arrêté. Votre texte est conservé.'));
    $('pipelineDraftDismiss').addEventListener('click', () => stopDraft('Proposition ignorée. Votre texte est conservé.'));
    $('pipelineDraftApply').addEventListener('click', () => {
      if (!proposal) return;
      for (const key of ['title', 'spec', 'service', 'priority']) $(fields[key]).value = proposal[key];
      updateGuidance();
      stopDraft('Brouillon appliqué au formulaire. Enregistrez quand vous êtes prêt.');
      $(fields.spec).focus();
    });
    for (const event of ['input', 'change']) form.addEventListener(event, () => {
      updateGuidance();
      if (drafting || proposal) stopDraft('Vos modifications sont conservées. Vous pouvez demander un nouveau brouillon.');
    });
    $('pipelineUseLatest').addEventListener('click', () => {
      if (!latest) return;
      current = latest.task; token = latest.editToken; fill(current); latest = null;
      $('pipelineEditorConflict').hidden = true; $('pipelineEditorSave').disabled = false; status('Version enregistrée chargée.');
      if ($('pipelineEditorDetails').open) void loadRoadmap();
    });
    $('pipelineKeepEdits').addEventListener('click', () => {
      if (!latest) return;
      const draft = values(); current = latest.task; token = latest.editToken; fill(current);
      // Keep the latest snapshot as the comparison base, then restore the user's draft.
      const savedBase = baseline; fill(draft); baseline = savedBase; latest = null;
      $('pipelineEditorConflict').hidden = true; $('pipelineEditorSave').disabled = false; status('Votre brouillon est prêt à remplacer la version comparée.');
      if ($('pipelineEditorDetails').open) void loadRoadmap();
    });
    form.addEventListener('keydown', event => {
      if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') { event.preventDefault(); if (!$('pipelineEditorSave').disabled) form.requestSubmit(); }
    });
  });
  window.PipelineTaskEditor = { open };
})();
