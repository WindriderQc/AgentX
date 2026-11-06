'use strict';

// Math Lab in Super Dad (#1270), phase 1: the shared formula grammar, the
// `math` display kind, what Nestor reads from a selected math card, and the
// cube pictures beside the model's own answer in the adult space.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const math = require('../../../public/js/math-expression');
const { createReplyChannels, contract, storedDisplay, historyText } = require('../reply-channels');
const { presentationEvidence } = require('../screen-context');
const { mathPictureFor } = require('../math-scene');
const screenPages = require('../../../public/js/screen-pages');
const { harness } = require('./fixtures/persona-journey.cjs');

const value = (source, scope = {}, names = Object.keys(scope)) => {
  const parsed = math.parseExpression(source, names);
  assert.ok(parsed.ok, `${source}: ${parsed.error?.message}`);
  return math.evaluate(parsed.tree, scope);
};
const WAVE = 'y = a*sin(b*x)\na = 1 in [-3, 3]\nb = 2 in [0.5, 4]\nx in [-2*pi, 2*pi]';

test('the grammar follows ordinary precedence, implicit products and the allowed functions', () => {
  assert.equal(value('1 + 2 * 3'), 7);
  assert.equal(value('-x^2', { x: 3 }), -9);
  assert.equal(value('2^3^2'), 512, 'powers are right-associative');
  assert.equal(value('2x + 1', { x: 4 }), 9);
  assert.equal(value('ax', { a: 3, x: 2 }), 6, 'single-letter names multiply');
  assert.equal(value('(x+1)(x-1)', { x: 3 }), 8);
  assert.equal(value('3sin(pi/2)'), 3);
  assert.equal(value('|x| + abs(-2)', { x: -5 }), 7);
  assert.ok(Math.abs(value('e^1') - Math.E) < 1e-12);
  assert.equal(value('log(e)'), 1, 'log is the natural logarithm');
  assert.equal(value('sqrt(16) + exp(0) + cos(0) + tan(0)'), 6);
  assert.equal(value('x² · 2 × 1 ÷ 2 − 1', { x: 3 }), 8, 'typed symbols map to the same operators');
  assert.equal(value('2**3'), 8);
  assert.ok(Number.isNaN(value('sqrt(-1)')), 'undefined values stay NaN, never a guess');
});

test('the canonical text parses back to the same function', () => {
  for (const source of ['-x^2', '(x+1)^2', 'x^(-1)', '2^3^2', 'a-(b-x)', 'a/(b*x)', '-(x+1)', 'x - -1', 'a*-x', '(x^2)^3']) {
    const names = ['x', 'a', 'b'], scope = { x: 1.7, a: 0.4, b: -2.3 };
    const first = math.parseExpression(source, names);
    const again = math.parseExpression(math.format(first.tree), names);
    assert.ok(again.ok, math.format(first.tree));
    assert.equal(math.evaluate(again.tree, scope), math.evaluate(first.tree, scope), source);
  }
});

test('anything outside the grammar is refused, and nothing reaches eval', () => {
  const refused = ['process.exit()', 'constructor', '__proto__', 'x; alert(1)', '`x`', 'x = 1', 'y', 'sinx', 'sin x', '(x', 'x)',
    '1 +', 'max(1, 2)', 'this', 'x[0]', '"x"', '', '9'.repeat(300), '('.repeat(40) + 'x' + ')'.repeat(40)];
  for (const source of refused) assert.equal(math.parseExpression(source, ['x']).ok, false, source);
  const code = fs.readFileSync(path.join(__dirname, '../../../public/js/math-expression.js'), 'utf8');
  assert.doesNotMatch(code, /\beval\s*\(|new\s+Function|Function\s*\(/);
});

test('a math block declares one function, its parameters with ranges and its windows', () => {
  const wave = math.parsePlot(WAVE);
  assert.ok(wave.ok);
  assert.deepEqual(wave.plot.parameters, [{ name: 'a', value: 1, min: -3, max: 3 }, { name: 'b', value: 2, min: 0.5, max: 4 }]);
  assert.equal(wave.plot.expression, 'a * sin(b * x)');
  assert.ok(Math.abs(wave.plot.x[1] - 2 * Math.PI) < 1e-12);
  assert.equal(wave.text, 'y = a * sin(b * x)\na = 1 in [-3, 3]\nb = 2 in [0.5, 4]\nx in [-6.283185307, 6.283185307]');
  assert.ok(math.parsePlot(wave.text).ok, 'the canonical body is itself a valid block');
  const fenced = math.parsePlot('```\nf(x) = x^2 - 4\n- y in [-5, 5].\n```');
  assert.ok(fenced.ok);
  assert.deepEqual([fenced.plot.x, fenced.plot.y], [[-10, 10], [-5, 5]]);
  const cases = {
    'y = a*x': 'unknown_name', 'a = 1 in [0, 2]': 'no_function', 'y = x\ny = 2x': 'one_function', 'y = x*e\ne = 1 in [0, 3]': 'reserved',
    'y = a*x\na = 1 in [0, 2]\na = 2 in [0, 3]': 'duplicate', 'y = a*x\na = 9 in [0, 5]': 'range', 'y = a*x\na = 1': 'range',
    'y = x\nx in [3, 1]': 'range', 'y = x\nLa parabole est jolie': 'line', 'y = x\nx in [0, 1e9]': 'number'
  };
  for (const [body, code] of Object.entries(cases)) assert.equal(math.parsePlot(body).error?.code, code, body);
  const many = ['y = x', ...'abcdfgh'.split('').map(name => `${name} = 0 in [-1, 1]`)].join('\n');
  assert.equal(math.parsePlot(many).error.code, 'parameters');
});

test('the points come from the formula with the current slider values, gaps where it is undefined', () => {
  const wave = math.parsePlot(WAVE);
  const described = math.describe(wave, { a: 2.5 });
  assert.equal(described.parameters[0].value, 2.5);
  assert.equal(described.points.length, 9);
  assert.deepEqual(described.points[2], [Number(math.formatNumber(-Math.PI)), 0]);
  const quarter = math.sample(wave.tree, { ...wave.plot, x: [Math.PI / 4, Math.PI / 4 + 1] }, { a: 2.5 }, 1)[0];
  assert.ok(Math.abs(quarter[1] - 2.5) < 1e-12, 'a * sin(b * pi/4) with a = 2.5, b = 2');
  const root = math.parsePlot('y = sqrt(x)\nx in [-4, 4]');
  const points = math.sample(root.tree, root.plot, {}, 8);
  assert.deepEqual(points.slice(0, 4).map(point => point[1]), [null, null, null, null]);
  assert.equal(points[8][1], 2);
  const tangent = math.parsePlot('y = tan(x)\nx in [-3, 3]');
  const window = math.fitY(math.sample(tangent.tree, tangent.plot), tangent.plot);
  assert.ok(window[1] - window[0] < 200, 'the fitted window does not chase the asymptotes');
});

const channel = (text, options = {}) => {
  const channels = createReplyChannels({ allowMath: true, ...options });
  for (let i = 0; i < text.length; i += 7) channels.push(text.slice(i, i + 7));
  return channels.end();
};

test('a valid math block reaches the screen as its canonical formula; the explanation stays spoken', () => {
  const result = channel(`Voici une onde. <show kind="math" title="Une onde">${WAVE}</show> Monte a pour l’agrandir.`);
  assert.equal(result.display.length, 1);
  assert.equal(result.display[0].kind, 'math');
  assert.equal(result.display[0].title, 'Une onde');
  assert.equal(result.display[0].body, math.parsePlot(WAVE).text);
  assert.match(result.say, /Voici une onde\. Monte a pour l’agrandir\./);
  assert.doesNotMatch(result.say, /sin|\[-3/);
  assert.deepEqual(storedDisplay(result.display)[0], { id: 'b1', kind: 'math', title: 'Une onde', body: result.display[0].body });
  assert.match(historyText(result.say, result.display), /<show kind="math" title="Une onde">\ny = a \* sin/);
  const read = channel(`Lis-moi ça. <show kind="math">${WAVE}</show>`, { readAloud: true });
  assert.doesNotMatch(read.say, /sin/, 'an explicit reading does not spell out the formula');
});

test('an invalid or disallowed math block stays readable as code and is never drawn', () => {
  const invalid = channel('Regarde. <show kind="math" title="Courbe">y = a*x + window.alert(1)</show>');
  assert.deepEqual([invalid.display[0].kind, invalid.display[0].title], ['code', 'Formule non tracée : Courbe']);
  assert.equal(invalid.display[0].body, 'y = a*x + window.alert(1)');
  const family = channel(`Regarde. <show kind="math">${WAVE}</show>`, { allowMath: false });
  assert.equal(family.display[0].kind, 'code', 'Famille keeps its cube pictures; no math cards');
  assert.match(contract(), /kind="math"/);
  assert.match(contract(), /single-letter parameter/);
  assert.doesNotMatch(contract({ family: true }), /kind="math"/);
});

test('Nestor reads the selected math card as Core-validated formula, values and computed points', () => {
  const body = math.plotText(math.parsePlot(WAVE).plot, { a: 2 });
  const row = { contract: 'agentx.presentation/v1', id: 'card-1', revision: 'card-1', kind: 'math', title: 'Une onde', status: 'visible',
    observation: 'formula_and_parameters', text: body, math: { points: [[0, 999]] } };
  const selected = presentationEvidence([row], screenPages);
  assert.equal(selected.observation, 'formula_and_parameters');
  assert.equal(selected.text, body);
  assert.equal(selected.math.computedBy, 'core');
  assert.deepEqual(selected.math.parameters.map(item => [item.name, item.value]), [['a', 2], ['b', 2]]);
  assert.ok(!selected.math.points.some(([, y]) => y === 999), 'browser-supplied numbers are ignored');
  const tampered = presentationEvidence([{ ...row, text: 'y = fetch(x)' }], screenPages);
  assert.equal(tampered.status, 'unavailable');
  assert.equal(tampered.text, undefined);
});

test('Famille answers a cube question itself; Super Dad gets the same picture beside the model', () => {
  const family = mathPictureFor('Combien font 8 + 5 ?', { childSafe: true });
  assert.equal(family.answeredBy, 'core');
  assert.match(family.reply, /13/);
  const adult = mathPictureFor('Combien font 8 + 5 ?', { childSafe: false });
  assert.deepEqual(adult.scene, family.scene);
  assert.equal(adult.reply, null);
  assert.equal(adult.answeredBy, 'model');
  assert.match(adult.context, /cube picture of 8 \+ 5 = 13/);
  assert.equal(mathPictureFor('Explique-moi les dérivées', { childSafe: false }), null);
  assert.equal(mathPictureFor('combien font 15 + 9', { childSafe: false }), null, 'out of bounds: no clamped picture');
});

async function streamedTurn(h, text) {
  const lines = [];
  const res = { on() {}, removeListener() {}, writableEnded: false, headersSent: false,
    status() { return res; }, set() { res.headersSent = true; return res; },
    write(chunk) { lines.push(...String(chunk).split('\n').filter(Boolean).map(JSON.parse)); },
    end(chunk) { if (chunk) res.write(chunk); res.writableEnded = true; } };
  await h.handle({ params: { sessionId: h.session.sessionId }, body: { text, channel: 'text', stream: true } }, res, h.pack.childSafe ? 'child' : 'private');
  return lines;
}

for (const backend of ['agentx', 'openclaw']) {
  test(`Super Dad on ${backend} shows the cubes and still asks the model for its own answer`, async () => {
    const h = harness({ packId: 'personal_operator', backend, response: 'Huit plus cinq font treize, voici pourquoi.' });
    const events = await streamedTurn(h, 'Combien font 8 + 5 ?');
    assert.deepEqual(events.find(row => row.type === 'scene')?.scene, { schema: 'agentx.math-scene.v1', kind: 'add', a: 8, b: 5 });
    assert.equal(h.sent.length, 1, 'the model answers');
    assert.match(h.sent[0].request, /cube picture of 8 \+ 5 = 13/);
    assert.match(events.find(row => row.type === 'done').data.reply.text, /voici pourquoi/);
    const ordinary = await streamedTurn(h, 'Raconte-moi une histoire.');
    assert.equal(ordinary.some(row => row.type === 'scene'), false);
    assert.doesNotMatch(h.sent[1].request, /cube picture/);
  });
}

test('Famille keeps its immediate cube answer without inference', async () => {
  const h = harness({ packId: 'kidx_nestor', backend: 'agentx' });
  const events = await streamedTurn(h, 'Combien font 8 + 5 ?');
  assert.equal(events.find(row => row.type === 'scene')?.scene.kind, 'add');
  assert.equal(h.sent.length, 0);
});
