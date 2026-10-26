/* GraphysX Center page status: the <graphysx-center> receipts as one line of text.
   Every event is a receipt of what the page showed, never of a change applied: the Center
   applies a proposal only when the person presses Apply inside it. */
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
