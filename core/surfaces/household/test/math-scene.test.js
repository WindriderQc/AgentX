'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { mathSceneFor, mathReply, mathTurnFor } = require('../math-scene');

test('additions to 20 are recognised in digits and words, French and English', () => {
  const cases = [
    ['Nestor, combien font 3 + 4 ?', 3, 4],
    ['combien ça fait huit plus cinq', 8, 5],
    ['Combien font douze et huit?', 12, 8],
    ['c’est quoi 9+9', 9, 9],
    ['dix-sept plus trois', 17, 3],
    ['what is two plus two', 2, 2],
    ['how much is 7 and 6', 7, 6],
    ['un plus un égale ?', 1, 1]
  ];
  for (const [text, a, b] of cases) {
    assert.deepEqual(mathSceneFor(text), { schema: 'agentx.math-scene.v1', kind: 'add', a, b }, text);
  }
});

test('counting to 100 is recognised, including compound French numbers', () => {
  const cases = [
    ['Compte jusqu’à 30', 30],
    ['peux-tu compter jusqu’à cent ?', 100],
    ['compte jusqu a soixante et onze', 71],
    ['compte jusqu’à quatre-vingt-dix-sept', 97],
    ['compte jusqu’à vingt et un', 21],
    ['count to twenty-five', 25],
    ['can you count up to 100', 100]
  ];
  for (const [text, to] of cases) {
    assert.deepEqual(mathSceneFor(text), { schema: 'agentx.math-scene.v1', kind: 'count', to }, text);
  }
});

test('ordinary talk and out-of-bounds questions get no picture', () => {
  for (const text of ['J’ai 2 et 3 amis', 'je veux plus de bonbons', 'Raconte-moi une histoire',
    'combien font 15 + 9', 'compte jusqu’à 150', 'compte jusqu’à zéro', 'combien font 0 + 0', '', null]) {
    assert.equal(mathSceneFor(text), null, String(text));
  }
});

test('Nestor answers at once, in the order the picture moves and in the child’s language', () => {
  assert.deepEqual(mathTurnFor('Nestor, combien font 8 + 5 ?'), {
    scene: { schema: 'agentx.math-scene.v1', kind: 'add', a: 8, b: 5 },
    reply: '8 plus 5, ça fait 13 ! Regarde : 2 cubes orange complètent la dizaine, et il en reste 3.'
  });
  assert.equal(mathTurnFor('what is 9 plus 3').reply, '9 plus 3 makes 12! Look: 1 orange cube completes the ten, and 2 are left over.');
  assert.equal(mathReply({ kind: 'add', a: 4, b: 3 }), '4 plus 3, ça fait 7 ! Regarde : 4 cubes bleus et 3 cubes orange.');
  assert.equal(mathReply({ kind: 'add', a: 7, b: 3 }), '7 plus 3, ça fait 10 ! Regarde : ça fait une dizaine complète !');
  assert.equal(mathReply({ kind: 'add', a: 12, b: 5 }), '12 plus 5, ça fait 17 ! Regarde : une dizaine complète, et 7 de plus.');
  assert.equal(mathReply({ kind: 'add', a: 9, b: 1 }), '9 plus 1, ça fait 10 ! Regarde : ça fait une dizaine complète !');
  assert.equal(mathTurnFor('compte jusqu’à 47').reply, 'On compte jusqu’à 47 ! Regarde : 4 dizaines et 7 unités, ça fait 47.');
  assert.equal(mathTurnFor('compte jusqu’à 10').reply, 'On compte ensemble : 1, 2, 3, 4, 5, 6, 7, 8, 9, 10 !');
  assert.equal(mathTurnFor('count to 30').reply, 'Let\'s count to 30! Look: 3 tens make 30.');
  assert.equal(mathTurnFor('Raconte une histoire'), null);
});
