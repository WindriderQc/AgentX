(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./pipeline-code-steps'), require('./pipeline-code-step-graph'));
  else root.CodingWorkEvidence = factory(root.PipelineCodeSteps, root.PipelineCodeStepGraph);
})(typeof window === 'undefined' ? globalThis : window, function (steps, graph) {
  'use strict';
  const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  function render(attempts) {
    const latest = (attempts || []).reduce((a, b) => !a || Number(b.attempt) > Number(a.attempt) ? b : a, null);
    const body = latest?.codeStepGraph != null
      ? graph.render(latest.codeStepGraph, { nativeSessionMode: 'pipeline' })
      : steps.render(latest?.codeSteps);
    return '<h3>Exécution et étapes</h3>'
      + `<p>${latest ? `Dernière tentative consignée : ${esc(latest.attempt)}` : 'Aucune tentative consignée.'}</p>`
      + (body || '<p>Aucun plan d’étapes consigné pour cette tentative. Les comptes rendus peuvent documenter un travail réalisé.</p>')
      + '<p>Étapes, décision humaine, publication et déploiement restent des preuves distinctes.</p>';
  }
  return { render };
});
