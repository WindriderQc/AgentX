'use strict';
const policy = require('../../public/js/image-text-policy');
const label = { id: 'title', text: 'École & façade 💡', placement: 'sur le cartouche central' };
const choice = (strategy = 'two-pass', labels = [label]) => ({ version: 1, enabled: true, strategy, labels });
const constraints = { version: 1, items: [
  { id: 'exact', kind: 'exact-text', text: label.text },
  { id: 'owl', kind: 'required-element', text: 'A central owl' }
] };

test('unchecked choices add a no-text instruction without rewriting the visual brief', () => {
  const disabled = { version: 1, enabled: false, strategy: 'auto', labels: [] };
  expect(policy.compose('A scene', undefined, disabled)).toMatch(/^A scene\n\nGESTION/);
  expect(policy.compose('A scene', undefined, disabled)).toContain('Aucun texte');
  expect(() => policy.compose('A scene', constraints, disabled)).toThrow(/Coche/);
  expect(() => policy.validatePlan({ version: 1 }, disabled)).toThrow(/désactivée/);
  expect(policy.compose('Legacy brief')).toBe('Legacy brief');
});

test('single pass carries exact words and two passes retain them only in metadata', () => {
  expect(policy.compose('A scene', constraints, choice('single-pass'))).toContain(label.text);
  const rendered = policy.compose('A scene', constraints, choice());
  expect(rendered).not.toContain(label.text);
  expect(rendered).toContain('A central owl');
  expect(rendered).toContain('sur le cartouche central');
  expect(rendered).toContain('surfaces vides');
  expect(policy.known(choice(), constraints)).toEqual([label]);
});

test('automatic and empty choices require a reviewed plan before rendering', () => {
  expect(() => policy.compose('A scene', undefined, choice('auto'))).toThrow(/Hermes/);
  expect(() => policy.compose('A scene', undefined, choice('two-pass', []))).toThrow(/textes exacts/);
  const plan = { version: 1, strategy: 'two-pass', reason: 'Libellés précis en calques.', labels: [label] };
  expect(policy.applyPlan(plan, choice('auto'))).toEqual(choice());
  expect(policy.applyPlan(plan, choice('auto', []))).toEqual(choice());
});

test('Hermes cannot omit, rename, change spelling or move protected exact texts', () => {
  const plan = { version: 1, strategy: 'two-pass', reason: 'Calques.', labels: [label] };
  for (const changed of [{ ...label, text: 'Ecole' }, { ...label, id: 'new-id' }, { ...label, placement: 'ailleurs' }]) {
    expect(() => policy.validatePlan({ ...plan, labels: [changed] }, choice('auto'))).toThrow(/modifié ou omis/);
  }
  expect(() => policy.validatePlan(plan, choice('single-pass'))).toThrow(/méthode/);
  const inherited = { ...label, id: 'constraint.exact', placement: '' };
  expect(policy.validatePlan({ ...plan, labels: [inherited] }, choice('auto', []), constraints).labels).toEqual([inherited]);
  expect(() => policy.validatePlan({ ...plan, labels: [label] }, choice('auto', []), constraints)).toThrow(/modifié ou omis/);
});

test('strict schemas, Unicode and combined renderer budgets apply before submission', () => {
  for (const changed of [{ enabled: 1 }, { strategy: '__proto__' }, { strategy: ['auto'] }, { labels: [label, label] },
    { labels: [{ ...label, text: '\ud800' }] }, { labels: [{ ...label, text: '😀'.repeat(301) }] },
    { labels: [{ ...label, arbitrary: true }] }, { version: true }, { injected: true }]) {
    expect(() => policy.validate({ ...choice(), ...changed })).toThrow();
  }
  expect(policy.validate(choice('single-pass', [{ ...label, text: '😀'.repeat(300) }])).labels[0].text.length).toBe(600);
  expect(() => policy.compose('v'.repeat(7990), undefined, choice())).toThrow(/8 000/);
});

test('image request identity includes lettering metadata even for identical blank-area prompts', () => {
  const service = require('../../src/services/images/imageService');
  const config = { defaultProfile: 'quick', profiles: { quick: { family: 'klein', maxPixels: 1048576 } } };
  const input = { actionKey: 'policy-fixture', prompt: 'A scene', seed: 7, textPolicy: choice() };
  const first = service.validate(input, config);
  const next = service.validate({ ...input, textPolicy: choice('two-pass', [{ ...label, text: 'Other exact title' }]) }, config);
  expect(first.request.prompt).toBe(next.request.prompt);
  expect(first.requestHash).not.toBe(next.requestHash);
  expect(first.request.visualPrompt).toBe(input.prompt);
  expect(first.request.textPolicy).toEqual(choice());
});

test.each([
  [{ version: 1, enabled: false, strategy: 'auto', labels: [] }, undefined],
  [choice('single-pass'), constraints], [choice('two-pass'), constraints]
])('exact final budgets include all added instructions and reject one extra unit', (selection, protectedItems) => {
  const initial = policy.inspect('A scene', protectedItems, selection);
  expect(initial.renderUnits).toBe(policy.compose('A scene', protectedItems, selection).length);
  expect(initial.overheadUnits + initial.maxVisualUnits).toBe(8000);
  expect(initial.remainingUnits).toBe(8000 - initial.renderUnits);
  const full = 'v'.repeat(initial.maxVisualUnits);
  expect(policy.compose(full, protectedItems, selection)).toHaveLength(8000);
  const over = policy.inspect(full + 'v', protectedItems, selection);
  expect(over.renderUnits).toBe(8001); expect(over.prompt).toHaveLength(8001);
  expect(() => policy.compose(full + 'v', protectedItems, selection)).toThrow(/8001.*8 000/);
});

test('planning gets canonical budgets for each available strategy and remains distinct from ready rendering', () => {
  const automatic = choice('auto');
  expect(policy.inspect('Original long brief', constraints, automatic)).toMatchObject({ needsPlan: true, renderUnits: null });
  const budget = policy.planningBudget(constraints, automatic);
  expect(budget).toMatchObject({ version: 1, limit: 8000, labelsMayChange: true });
  for (const strategy of ['single-pass', 'two-pass']) {
    expect(budget.descriptionLimits[strategy]).toBe(policy.inspect('', constraints, choice(strategy)).maxVisualUnits);
  }
});

test('re-pasting the exact rendering preview does not duplicate its protected or lettering suffix', () => {
  const selected = choice();
  const rendered = policy.compose('A scene', constraints, selected);
  expect(policy.compose(rendered, constraints, selected)).toBe(rendered);
  expect(policy.visual(rendered, constraints, selected)).toBe('A scene');
  const service = require('../../src/services/images/imageService');
  const config = { defaultProfile: 'quick', profiles: { quick: { family: 'klein', maxPixels: 1048576 } } };
  const input = { actionKey: 'policy-fixture', prompt: 'A scene', seed: 7, constraints, textPolicy: selected };
  const first = service.validate(input, config), pasted = service.validate({ ...input, prompt: rendered }, config);
  expect(pasted.request.visualPrompt).toBe('A scene'); expect(pasted.requestHash).toBe(first.requestHash);
});
