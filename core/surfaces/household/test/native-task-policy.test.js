'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { requestsTaskContextRead } = require('../native-task-policy');
const { requestedListLimit } = require('../requested-list-limit');
const { workResultPresentation } = require('../work-result-presentation');

test('only the explicit open personal-task scope can reuse the context read', () => {
  for (const request of ['Lis ma liste de tâches personnelles ouvertes. Ne modifie rien.', 'Regarde mes tâches.', 'Read my open tasks.']) {
    assert.equal(requestsTaskContextRead(request), true, request);
  }
  for (const request of ['Ne lis pas mes tâches.', 'Crée ma tâche.', 'Lis mes tâches terminées.', 'Read my completed tasks.',
    'Montre mes tâches du Pipeline.', 'Lis les tâches de mes enfants.', 'Comment organiser mes tâches ?', 'Bonjour.']) {
    assert.equal(requestsTaskContextRead(request), false, request);
  }
});

test('an explicit maximum is separate from totals, dates, negation and unconstrained lists', () => {
  assert.equal(requestedListLimit('Le total puis au plus trois titres.'), 3);
  assert.equal(requestedListLimit('At most 2 items.'), 2);
  assert.equal(requestedListLimit('Donne le total des 8 tâches.'), null);
  assert.equal(requestedListLimit('Ne donne pas au plus trois titres, lis tout.'), null);
  assert.equal(requestedListLimit('Lis ma liste complète.'), null);
  assert.equal(requestedListLimit('Maximum 0 titres.'), null);
});

test('a title cap retains nested detail for included entries and leaves code and complete native text intact', () => {
  const source = { text: '<show kind="code">- Code 1\n- Code 2</show>\n<show kind="list">'
    + '\n- First\n  - Child\n- Second\n- Third\n  Detail\n- Fourth\n</show>' };
  const result = workResultPresentation(source, { requestText: 'At most 3 titles.' });
  assert.match(result.displayText, /Code 2/);
  assert.match(result.displayText, /Child/);
  assert.match(result.displayText, /Third/);
  assert.doesNotMatch(result.displayText, /Fourth/);
  assert.match(source.text, /Fourth/);
});

test('an unmarked numbered list respects the requested cap without rewriting fenced code', () => {
  const source = { text: '```text\n1. Code A\n2. Code B\n```\nVoici les titres :\n1. Alpha\n2. Bravo\n3. Charlie\n4. Delta' };
  const view = workResultPresentation(source, { requestText: 'At most 3 titles.' });
  assert.match(view.displayText, /Charlie/);
  assert.doesNotMatch(view.displayText, /Delta/);
  assert.match(source.text, /Delta/);
  assert.match(view.displayText, /Code B/);
});
