'use strict';
const ui = require('../../public/js/pipeline-work-links');
test('the relationship form separates explicit decisions, scope review and observed outcomes', () => {
  const markup = ui.markup({ pipelineId: '0001', workView: { revision: 2, scopeFingerprint: 'a'.repeat(64), entries: [{
    reference: { kind: 'github_issue', repository: 'example/project', number: 42 }, relation: 'duplicate_report',
    label: 'example/project#42', href: 'https://github.com/example/project/issues/42', scopeCurrent: false,
    actor: { declared: 'fixture-operator' }, reason: 'Inspected a synthetic duplicate report.' }] } });
  expect(markup).toContain('périmètre à relire'); expect(markup).toContain('Signalement en doublon');
  expect(markup).toContain('<option value="">Choisir une opération</option>');
  expect(markup).toContain('data-scope="' + 'a'.repeat(64));
  expect(markup).toContain('aucun contenu de conversation n’est importé');
  expect(ui.markup({ pipelineId: '0001' })).toBe('');
});
test('reference reasons remain escaped data, not markup or instructions', () => {
  const markup = ui.markup({ pipelineId: '0001', workView: { revision: 1, scopeFingerprint: 'a'.repeat(64), entries: [{
    reference: { kind: 'conversation', runtime: 'codex', namespace: 'synthetic', id: 'fixture' }, relation: 'report', label: '<script>fixture</script>',
    reason: '<img src=x onerror=fixture()>', scopeCurrent: true }] } });
  expect(markup).not.toContain('<script>'); expect(markup).not.toContain('<img'); expect(markup).toContain('&lt;img');
});
