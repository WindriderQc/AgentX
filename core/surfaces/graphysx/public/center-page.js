/* GraphysX Center status: delivery receipts and the person's decision as one line of text.
   Only an accepted outcome confirms application, at the revision/commit in that receipt. */
(function () {
  'use strict';
  const status = document.getElementById('graphysx-status');
  const center = document.querySelector('graphysx-center');
  if (!status || !center) return;
  const say = (text, error = false) => { status.textContent = text; status.classList.toggle('error', error); status.hidden = false; };
  const clip = (value, max) => String(value || '').slice(0, max);

  center.addEventListener('graphysx-center-ready', () => { status.hidden = true; });
  center.addEventListener('graphysx-center-pushed', (event) => {
    const intent = clip(event.detail && event.detail.intent, 200);
    say(intent ? `Nestor propose : ${intent} — rien n’est appliqué tant que vous n’acceptez pas dans la page.`
      : 'Nestor propose un changement — rien n’est appliqué tant que vous n’acceptez pas dans la page.');
  });
  center.addEventListener('graphysx-center-receipt', (event) => {
    const detail = event.detail || {};
    if (detail.status === 'shown') say(detail.stale ? 'Proposition affichée, mais la scène a bougé depuis : elle est périmée.' : 'Proposition affichée dans la page ; à vous de décider.');
    else say(`Proposition refusée par la page : ${clip(detail.reason, 300) || 'raison inconnue'}.`, true);
  });
  center.addEventListener('graphysx-center-outcome', (event) => {
    const detail = event.detail || {};
    if (!Number.isInteger(detail.revision) || detail.revision < 0) return;
    switch (detail.status) {
      case 'accepted':
        say(`Changement accepté à la révision ${detail.revision}${detail.commitId ? ` (${clip(detail.commitId, 120)})` : ''}.`);
        break;
      case 'discarded':
        say('Proposition écartée ; aucun changement appliqué par cette proposition.');
        break;
      case 'stale':
        say(`Proposition périmée à la révision ${detail.revision} ; aucun changement appliqué.`, true);
        break;
      case 'rejected':
        say(`Changement refusé à la révision ${detail.revision} : ${clip(detail.reason, 300) || 'raison inconnue'}.`, true);
        break;
    }
  });
  center.addEventListener('graphysx-center-error', (event) => {
    const detail = event.detail || {};
    say(`GraphysX (${clip(detail.stage, 40) || 'erreur'}) : ${clip(detail.message, 300) || 'erreur inconnue'}`, true);
  });
  // The module is relayed by Core; an unconfigured or unpublished module never defines the element.
  setTimeout(() => {
    if (!window.customElements || !window.customElements.get('graphysx-center')) {
      say('Le module du Centre GraphysX n’est pas disponible sur cette instance.', true);
    }
  }, 15000);
}());
