(function (factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else { window.PipelineIntake = factory(); window.PipelineIntake.bind(document); }
})(function () {
  'use strict';
  const esc = value => String(value ?? '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
  const labels = { proposed: 'Proposition à trier', needs_clarification: 'Besoin à clarifier', accepted: 'Accepter le besoin',
    deferred: 'Reporter', declined: 'Ne pas retenir' };
  // A polling refresh replaces the form. Keep the last submitted identity
  // outside that DOM node so retrying the same intent still reconciles it.
  const requests = new Map();
  function markup(task, reviewer = '') {
    const view = task.intakeView;
    if (!view || view.state === 'native_domain') return '';
    return `<section class="pipeline-drawer-section" aria-label="Décision sur le besoin">
      <h3>${esc(view.label)}</h3>
      <p class="pipeline-drawer-copy">${esc(view.reason || (view.state === 'legacy_unrecorded'
        ? 'Ce dossier conserve ses règles existantes; aucune acceptation historique n’est inventée.' : 'Relisez le besoin et son résultat attendu avant de décider.'))}</p>
      <p class="pipeline-drawer-context">Accepter le besoin ne lance aucun agent et n’accorde aucun droit d’exécution.</p>
      ${view.actor ? `<p class="pipeline-drawer-byline">Décision déclarée par ${esc(view.actor.declared || 'non précisé')}${view.decidedAt ? ` · ${esc(new Date(view.decidedAt).toLocaleString())}` : ''}.</p>` : ''}
      ${view.canDecide ? `<form class="pipeline-drawer-action" data-intake-decision data-task-id="${esc(task.pipelineId)}" data-revision="${Number(view.revision)}" data-scope="${esc(view.scopeFingerprint)}">
        <label>Décision<select name="state" required><option value="">Choisir une décision</option>${Object.entries(labels).map(([value, label]) => `<option value="${value}">${label}</option>`).join('')}</select></label>
        <label>Justification<textarea name="reason" required minlength="8" maxlength="1000" rows="3"></textarea></label>
        <label>Décision déclarée par<input name="by" required maxlength="120" value="${esc(reviewer)}"></label>
        <p data-intake-status role="status" aria-live="polite"></p>
        <button type="submit" class="pipeline-btn primary compact">Enregistrer la décision</button></form>`
        : '<p class="pipeline-drawer-context">Les décisions de triage ne changent pas une exécution ou une autorisation en cours. Utilisez son suivi natif avant de reconsidérer le besoin.</p>'}
      ${task.intake?.history?.length ? `<details><summary>Historique des décisions (${task.intake.history.length})</summary><ol>${task.intake.history.map(row => `<li>${esc(row.to)} · ${esc(row.actor?.declared || '')} · ${esc(row.reason)}</li>`).join('')}</ol></details>` : ''}
    </section>`;
  }
  function bind(document) {
    document.addEventListener('submit', async event => {
      const form = event.target.closest?.('form[data-intake-decision]');
      if (!form) return;
      event.preventDefault();
      if (form.dataset.saving === 'true' || !form.reportValidity()) return;
      const fields = new FormData(form);
      const intent = { state: fields.get('state'), reason: fields.get('reason'), by: fields.get('by'),
        expectedRevision: Number(form.dataset.revision), expectedScopeFingerprint: form.dataset.scope, confirm: true };
      const signature = JSON.stringify(intent);
      const previous = requests.get(form.dataset.taskId);
      const requestId = previous?.signature === signature ? previous.requestId : crypto.randomUUID();
      requests.set(form.dataset.taskId, { signature, requestId });
      form.dataset.saving = 'true';
      const submit = form.querySelector('button[type="submit"]'), status = form.querySelector('[data-intake-status]');
      submit.disabled = true; status.textContent = 'Enregistrement…';
      try {
        const response = await fetch(`/api/pipeline/tasks/${encodeURIComponent(form.dataset.taskId)}/intake`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...intent, requestId }) });
        const result = await response.json();
        if (!response.ok || result.status === 'error' || result.ok === false) throw new Error(result.message || 'La décision n’a pas été confirmée.');
        status.textContent = `${result.data?.replayed ? 'Décision déjà enregistrée' : 'Décision enregistrée'}. État actuel : ${result.data?.intakeView?.label || 'à relire'}. Aucun travail lancé.`;
        document.dispatchEvent(new CustomEvent('pipeline-task-saved', { detail: { pipelineId: form.dataset.taskId } }));
      } catch (error) { status.textContent = `${error.message} Votre justification est conservée; relisez le dossier si sa version a changé.`; }
      finally { form.dataset.saving = 'false'; submit.disabled = false; }
    });
  }
  return { markup, bind };
});
