(function (factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else { window.PipelineWorkLinks = factory(); window.PipelineWorkLinks.bind(document); }
})(function () {
  'use strict';
  const requests = new Map();
  const esc = value => String(value ?? '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
  const relationLabels = { report: 'Signalement source', duplicate_report: 'Signalement en doublon', related_work: 'Travail lié' };
  function outcomesMarkup(outcomes) {
    if (!outcomes) return '';
    const publication = outcomes.publication, observation = publication?.observation;
    return `<section aria-label="Étapes du résultat"><h4>Étapes du résultat</h4>
      <p>État du dossier : ${esc(outcomes.taskRecord.status)}${outcomes.taskRecord.resolution ? ` · ${esc(outcomes.taskRecord.resolution)}` : ''}.</p>
      <p>${publication ? `<a href="${esc(publication.href)}" target="_blank" rel="noopener noreferrer">PR ${esc(publication.repository)}#${publication.number}</a> · ${observation
        ? `${observation.merged ? 'fusion observée' : 'fusion non observée'} · CI : ${esc(observation.ci || 'inconnue')} · ${esc(observation.observedAt || '')}`
        : 'aucune observation associée à cette révision'}` : 'Aucune PR associée dans les observations natives de cette vue.'}</p>
      <p>Installation : preuve à consulter séparément. Acceptation du résultat : non déduite de la fermeture du dossier ou de la fusion.</p>
      <p>Les tentatives et les fichiers conservent leurs propres preuves dans ce dossier.</p></section>`;
  }
  function markup(task, reviewer = '') {
    const view = task.workView;
    if (!view) return '';
    return `<details class="pipeline-drawer-section pipeline-work-links" data-drawer-disclosure="work-links"><summary>Signalements, liens et résultats (${view.entries.length})</summary>
      <p>Un lien conserve la provenance. Il ne ferme aucun dossier et n’accorde aucune autorisation.</p>
      <ul>${view.entries.map(row => `<li>${esc(relationLabels[row.relation] || row.relation)} : ${row.href
        ? `<a href="${esc(row.href)}"${row.reference.kind === 'github_issue' ? ' target="_blank" rel="noopener noreferrer"' : ''}>${esc(row.label)}</a>` : esc(row.label)}
        ${row.scopeCurrent ? '' : '<strong> · périmètre à relire</strong>'}
        <p>${esc(row.reason)} · ${esc(row.actor?.declared || '')}</p>
        <button type="button" class="pipeline-btn compact" data-work-fill="${esc(JSON.stringify(row.reference))}" data-relation="${esc(row.relation)}">Revoir ce lien</button></li>`).join('')}</ul>
      <form class="pipeline-drawer-action" data-work-links data-task-id="${esc(task.pipelineId)}" data-revision="${view.revision}" data-scope="${esc(view.scopeFingerprint)}">
        <label>Opération<select name="workOperation" required><option value="">Choisir une opération</option><option value="add">Ajouter un lien après inspection</option><option value="review">Confirmer le lien pour le périmètre actuel</option><option value="remove">Retirer le lien en conservant son historique</option></select></label>
        <label>Type de référence<select name="workKind"><option value="github_issue">Issue GitHub</option><option value="pipeline_task">Tâche Core</option><option value="conversation">Conversation déclarée</option></select></label>
        <fieldset data-work-kind="github_issue"><label>Dépôt (propriétaire/dépôt)<input name="workRepository" maxlength="201" required></label><label>Numéro de l’issue<input name="workNumber" type="number" min="1" step="1" required></label></fieldset>
        <fieldset data-work-kind="pipeline_task" hidden disabled><label>Identifiant de tâche Core<input name="workPipelineId" pattern="[0-9]{3,4}" required></label></fieldset>
        <fieldset data-work-kind="conversation" hidden disabled><label>Runtime<select name="workRuntime">${['agentx', 'codex', 'claude', 'openclaw', 'hermes', 'chatgpt'].map(name => `<option>${name}</option>`).join('')}</select></label><label>Identifiant de conversation<input name="workConversationId" maxlength="160" required></label><p>Référence déclarée seulement ; aucun contenu de conversation n’est importé.</p></fieldset>
        <label>Relation<select name="workRelation"><option value="report">Signalement source</option><option value="duplicate_report">Signalement en doublon</option><option value="related_work" disabled>Travail lié</option></select></label>
        <button type="button" class="pipeline-btn compact" data-work-lookup>Chercher les travaux liés à cette référence</button>
        <div data-work-matches role="status"></div>
        <label>Justification<textarea name="workReason" required minlength="8" maxlength="1000" rows="3"></textarea></label>
        <label>Décision déclarée par<input name="workBy" required maxlength="120" value="${esc(reviewer)}"></label>
        <p data-work-status role="status" aria-live="polite"></p>
        <button type="submit" class="pipeline-btn primary compact">Enregistrer le lien</button>
      </form>${outcomesMarkup(view.outcomes)}</details>`;
  }
  function updateKind(form) {
    const kind = form.elements.workKind.value;
    for (const group of form.querySelectorAll('[data-work-kind]')) group.hidden = group.disabled = group.dataset.workKind !== kind;
    const relation = form.elements.workRelation;
    for (const option of relation.options) option.disabled = (option.value === 'related_work') !== (kind === 'pipeline_task');
    if (relation.selectedOptions[0]?.disabled) relation.value = kind === 'pipeline_task' ? 'related_work' : 'report';
  }
  function referenceOf(form) {
    const fields = form.elements, kind = fields.workKind.value;
    if (kind === 'github_issue') return { kind, repository: fields.workRepository.value, number: Number(fields.workNumber.value) };
    if (kind === 'pipeline_task') return { kind, pipelineId: fields.workPipelineId.value };
    return { kind, runtime: fields.workRuntime.value, id: fields.workConversationId.value };
  }
  async function readResponse(response) {
    const result = await response.json();
    if (!response.ok || result.status === 'error' || result.ok === false) throw Error(result.message || 'Le résultat n’a pas été confirmé.');
    return result.data;
  }
  function bind(document) {
    document.addEventListener('change', event => {
      const form = event.target.closest?.('form[data-work-links]');
      if (form && event.target.name === 'workKind') updateKind(form);
    });
    document.addEventListener('click', async event => {
      const fill = event.target.closest?.('[data-work-fill]');
      if (fill) {
        const form = fill.closest('details').querySelector('form[data-work-links]'), ref = JSON.parse(fill.dataset.workFill);
        form.elements.workKind.value = ref.kind; updateKind(form);
        const names = { repository: 'workRepository', number: 'workNumber', pipelineId: 'workPipelineId', runtime: 'workRuntime', id: 'workConversationId' };
        for (const [key, name] of Object.entries(names)) if (ref[key] !== undefined) form.elements[name].value = ref[key];
        form.elements.workRelation.value = fill.dataset.relation; form.elements.workOperation.value = 'review';
        form.elements.workReason.focus(); return;
      }
      const button = event.target.closest?.('[data-work-lookup]');
      if (!button) return;
      const form = button.closest('form'), output = form.querySelector('[data-work-matches]');
      button.disabled = true; output.textContent = 'Recherche…';
      try {
        const result = await readResponse(await fetch('/api/pipeline/work-references?' + new URLSearchParams(referenceOf(form))));
        output.innerHTML = `<p>${result.matchedCount} tâche(s) liée(s) à cette référence exacte${result.truncated ? ' · liste partielle' : ''}.</p><ul>${result.tasks.map(task => `<li><a href="/pipeline?task=${encodeURIComponent(task.pipelineId)}">#${esc(task.pipelineId)} · ${esc(task.title)}</a> · ${esc(task.status)}${task.association?.active === false ? ' · admission d’origine, lien retiré' : ''}${task.association?.scopeCurrent === false ? ' · périmètre à relire' : ''}</li>`).join('')}</ul>`;
      } catch (error) { output.textContent = error.message; }
      finally { button.disabled = false; }
    });
    document.addEventListener('submit', async event => {
      const form = event.target.closest?.('form[data-work-links]');
      if (!form) return;
      event.preventDefault();
      if (form.dataset.saving === 'true' || !form.reportValidity()) return;
      const fields = form.elements;
      const intent = { operation: fields.workOperation.value, reference: referenceOf(form), relation: fields.workRelation.value,
        reason: fields.workReason.value, by: fields.workBy.value, expectedRevision: Number(form.dataset.revision), expectedScopeFingerprint: form.dataset.scope, confirm: true };
      const signature = JSON.stringify(intent), previous = requests.get(form.dataset.taskId);
      const requestId = previous?.signature === signature ? previous.requestId : crypto.randomUUID();
      requests.set(form.dataset.taskId, { signature, requestId }); form.dataset.saving = 'true';
      const button = form.querySelector('button[type=submit]'), status = form.querySelector('[data-work-status]');
      button.disabled = true; status.textContent = 'Enregistrement…';
      try {
        await readResponse(await fetch(`/api/pipeline/tasks/${encodeURIComponent(form.dataset.taskId)}/relationships`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...intent, requestId }) }));
        status.textContent = 'Lien enregistré. Aucun statut externe modifié.';
        document.dispatchEvent(new CustomEvent('pipeline-task-saved', { detail: { pipelineId: form.dataset.taskId } }));
      } catch (error) { status.textContent = `${error.message} Votre justification est conservée ; gardez la même requête pour réconcilier une réponse perdue.`; }
      finally { button.disabled = false; form.dataset.saving = 'false'; }
    });
  }
  return { markup, outcomesMarkup, bind, updateKind };
});
