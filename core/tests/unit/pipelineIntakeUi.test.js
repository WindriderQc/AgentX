'use strict';
const intake = require('../../public/js/pipeline-intake');
const task = extra => ({ pipelineId: '0123', intakeView: { state: 'proposed', label: 'Proposition à trier',
  revision: 1, scopeFingerprint: 'a'.repeat(64), canDecide: true, ...extra } });
test('the dossier asks for a decision and a rationale rather than implying execution approval', () => {
  const html = intake.markup(task(), 'fixture-operator');
  expect(html).toContain('Accepter le besoin'); expect(html).toContain('Ne pas retenir');
  expect(html).toContain('n’accorde aucun droit d’exécution');
  expect(html).toContain('data-revision="1"'); expect(html).toContain('data-scope="' + 'a'.repeat(64));
  expect(html).toContain('<option value="">Choisir une décision</option>');
  expect(html).not.toContain('selected');
});
test('native/private work and fenced executions cannot be decided through this form', () => {
  expect(intake.markup(task({ state: 'native_domain' }))).toBe('');
  expect(intake.markup(task({ canDecide: false }))).not.toContain('data-intake-decision');
  expect(intake.markup(task({ canDecide: false }))).toContain('suivi natif');
});
test('reasons and declared actor names remain escaped reference data', () => {
  const html = intake.markup(task({ reason: '<img src=x onerror=fixture()>', actor: { declared: '<script>fixture</script>' } }));
  expect(html).toContain('&lt;img'); expect(html).not.toContain('<img'); expect(html).not.toContain('<script>');
});
