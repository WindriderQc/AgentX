'use strict';

// Math Lab in Super Dad and Famille (#1270): the shared formula grammar (phase 1,
// the comparisons of phase 2, and the derivatives, tangents, areas and functions
// using functions of phase 3), the `math` display kind, what Nestor reads from
// a selected math card, and the cube pictures beside the model's own answer in
// the adult space. Famille gets the same card through a short contract and keeps
// Core's immediate cube answer.

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
const COMPARE = 'f(x) = x^2\ng(x) = a x + 1\na = 2 in [-3, 3]\nx in [-3, 3]';
const CALCULUS = "f(x) = x^3 - 3x\nf'(x)\ntangent f at p\narea f from 0 to b\np = 1 in [-2, 2]\nb = 1.5 in [0, 2]\nx in [-2.5, 2.5]";
const CIRCLE = 'c(t) = (r cos(t), r sin(t))\nr = 2 in [0.5, 3]';
const SADDLE = 'z = x^2 - y^2\nx in [-2, 2]\ny in [-2, 2]';

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

test('a math block declares its function, its parameters with ranges and its windows', () => {
  const wave = math.parsePlot(WAVE);
  assert.ok(wave.ok);
  assert.deepEqual(wave.plot.parameters, [{ name: 'a', value: 1, min: -3, max: 3 }, { name: 'b', value: 2, min: 0.5, max: 4 }]);
  assert.deepEqual(wave.plot.functions, [{ name: 'y', label: 'y', expression: 'a * sin(b * x)' }]);
  assert.equal(wave.plot.schema, 'agentx.math-plot.v4');
  assert.ok(Math.abs(wave.plot.x[1] - 2 * Math.PI) < 1e-12);
  assert.equal(wave.text, 'y = a * sin(b * x)\na = 1 in [-3, 3]\nb = 2 in [0.5, 4]\nx in [-6.283185307, 6.283185307]');
  assert.ok(math.parsePlot(wave.text).ok, 'the canonical body is itself a valid block');
  const fenced = math.parsePlot('```\nf(x) = x^2 - 4\n- y in [-5, 5].\n```');
  assert.ok(fenced.ok);
  assert.deepEqual([fenced.plot.x, fenced.plot.y], [[-10, 10], [-5, 5]]);
  assert.equal(fenced.text.split('\n')[0], 'f(x) = x^2 - 4', 'a named function keeps its name');
  const cases = {
    'y = a*x': 'unknown_name', 'a = 1 in [0, 2]': 'no_function', 'y = x\ny = 2x': 'duplicate', 'y = x*e\ne = 1 in [0, 3]': 'reserved',
    'y = a*x\na = 1 in [0, 2]\na = 2 in [0, 3]': 'duplicate', 'y = a*x\na = 9 in [0, 5]': 'range', 'y = a*x\na = 1': 'range',
    'y = x\nx in [3, 1]': 'range', 'y = x\nLa parabole est jolie': 'line', 'y = x\nx in [0, 1e9]': 'number'
  };
  for (const [body, code] of Object.entries(cases)) assert.equal(math.parsePlot(body).error?.code, code, body);
  const many = ['y = x', ...'abcdfgh'.split('').map(name => `${name} = 0 in [-1, 1]`)].join('\n');
  assert.equal(math.parsePlot(many).error.code, 'parameters');
});

test('a comparison draws up to four named functions sharing parameters and window', () => {
  const compare = math.parsePlot(COMPARE);
  assert.ok(compare.ok, compare.error?.message);
  assert.deepEqual(compare.plot.functions.map(fn => [fn.label, fn.expression]), [['f(x)', 'x^2'], ['g(x)', 'a * x + 1']]);
  assert.equal(compare.trees.length, 2);
  assert.equal(compare.text, 'f(x) = x^2\ng(x) = a * x + 1\na = 2 in [-3, 3]\nx in [-3, 3]');
  assert.ok(math.parsePlot(compare.text).ok, 'the canonical comparison is itself a valid block');
  const described = math.describe(compare, { a: -1 }, 2);
  assert.deepEqual(described.functions.map(fn => [fn.name, fn.points]), [['f', [[-3, 9], [0, 0], [3, 9]]], ['g', [[-3, 4], [0, 1], [3, -2]]]]);
  assert.ok(described.y[0] < -2 && described.y[1] > 9, 'one vertical window fitted to both curves');
  const five = ['f', 'g', 'h', 'k', 'p'].map(name => `${name}(x) = x`).join('\n');
  const cases = {
    'f(x) = x\nf = 1 in [0, 2]': 'duplicate', 'e(x) = x': 'reserved', 't(x) = x': 'reserved',
    'f(x) = x\nf(x) = 2x': 'duplicate', 'f(x) = x\ng(x) = q': 'unknown_name', [five]: 'functions'
  };
  for (const [body, code] of Object.entries(cases)) assert.equal(math.parsePlot(body).error?.code, code, body);
  assert.match(math.parsePlot('f(x) = x\ng(x) = q').error.message, /^g\(x\): /, 'the refusal names the function at fault');
});

test('the grammar answers the shared vectors that GraphysX also runs', () => {
  const vectors = require('../../../public/js/math-expression.vectors.json');
  const close = (actual, expected, label) => (typeof expected === 'string' ? assert.equal(String(actual), expected, label)
    : assert.ok(Math.abs(actual - expected) <= 1e-12 * Math.max(1, Math.abs(expected)), `${label}: ${actual} vs ${expected}`));
  assert.ok(vectors.expressions.length >= 50);
  for (const row of vectors.expressions) {
    const parsed = math.parseExpression(row.source, row.names);
    if (row.error) { assert.equal(parsed.error?.code, row.error, row.source.slice(0, 40)); continue; }
    assert.equal(math.format(parsed.tree), row.format, row.source);
    for (const { scope, value } of row.evaluations) close(math.evaluate(parsed.tree, scope), value, `${row.source} ${JSON.stringify(scope)}`);
  }
  const derived = vectors.expressions.filter(row => row.derivative);
  assert.ok(derived.length >= 40, 'the vectors cover the derivative rules');
  for (const row of derived) {
    const derivative = math.derive(math.parseExpression(row.source, row.names).tree);
    assert.equal(math.format(derivative), row.derivative, `d/dx ${row.source}`);
    for (const { scope, value } of row.derivativeEvaluations) close(math.evaluate(derivative, scope), value, `d/dx ${row.source} ${JSON.stringify(scope)}`);
  }
  for (const row of vectors.systems) {
    const read = math.parseFunctions(row.functions, row.names);
    const label = row.functions.map(fn => `${fn.name}=${fn.source}`).join('; ');
    if (row.error) { assert.deepEqual([read.error?.code, read.name], [row.error, row.failing], label); continue; }
    assert.deepEqual(read.functions.map(fn => math.format(fn.tree)), row.formats, label);
    for (const { scope, values } of row.evaluations) read.functions.forEach((fn, i) => close(math.evaluate(fn.expanded, scope), values[i], `${label} ${fn.name}`));
  }
  for (const row of vectors.fits) {
    const parsed = math.parseExpression(row.expression, ['x', ...row.parameters.map(p => p.name)]);
    const plot = { parameters: row.parameters, x: row.x, ...(row.declared ? { y: row.declared } : {}) };
    math.fitY(math.sample(parsed.tree, plot, {}, row.samples), plot).forEach((value, i) => close(value, row.fitted[i], row.expression));
  }
});

test('the shared vector file is what the generator writes from this grammar', () => {
  const { execFileSync } = require('node:child_process');
  execFileSync(process.execPath, [path.join(__dirname, '../../../scripts/math-expression-vectors.js'), '--check'], { stdio: 'pipe' });
});

test('derivatives follow the usual rules and read simply', () => {
  const d = (source, names = ['x']) => math.format(math.derive(math.parseExpression(source, names).tree));
  assert.equal(d('x^3 - 3x'), '3 * x^2 - 3');
  assert.equal(d('a*sin(b*x)', ['x', 'a', 'b']), 'a * b * cos(b * x)');
  assert.equal(d('exp(-x^2)'), '-2 * x * exp(-x^2)');
  assert.equal(d('1/x'), '-1 / x^2');
  assert.equal(d('x^3/3 - x'), 'x^2 - 1');
  assert.equal(d('ln(x)'), '1 / x');
  assert.equal(d('2^x'), '2^x * ln(2)');
  assert.equal(d('7'), '0');
  // Checked against a centred difference at many points.
  for (const source of ['x*sin(x)', 'sqrt(x^2 + 1)', 'tan(x)/x', 'x^x', 'exp(sin(x))', '|x - 1|']) {
    const tree = math.parseExpression(source, ['x']).tree, slope = math.derive(tree);
    for (const x of [-1.3, 0.4, 1.7, 2.9]) {
      const h = 1e-6, numeric = (math.evaluate(tree, { x: x + h }) - math.evaluate(tree, { x: x - h })) / (2 * h);
      if (Number.isFinite(numeric)) assert.ok(Math.abs(math.evaluate(slope, { x }) - numeric) < 1e-4 * Math.max(1, Math.abs(numeric)), `${source} at ${x}`);
    }
  }
});

test('a calculus block draws the derivative, a tangent on a slider and an area, all computed by Core', () => {
  const parsed = math.parsePlot(CALCULUS);
  assert.ok(parsed.ok, parsed.error?.message);
  assert.deepEqual([parsed.plot.derivatives, parsed.plot.tangents, parsed.plot.areas], [['f'], [{ of: 'f', at: 'p' }], [{ of: 'f', from: 0, to: 'b' }]]);
  assert.equal(parsed.text, "f(x) = x^3 - 3 * x\nf'(x)\ntangent f at p\narea f from 0 to b\np = 1 in [-2, 2]\nb = 1.5 in [0, 2]\nx in [-2.5, 2.5]");
  assert.equal(math.parsePlot(parsed.text).text, parsed.text, 'the canonical block is stable');
  assert.deepEqual(math.tangentAt(parsed, parsed.plot.tangents[0], { p: 1, b: 1.5 }), { of: 'f', x: 1, y: -2, slope: 0 }, 'flat at the local minimum');
  assert.deepEqual(math.tangentAt(parsed, parsed.plot.tangents[0], { p: 2, b: 1.5 }), { of: 'f', x: 2, y: 2, slope: 9 });
  const area = math.areaOf(parsed, parsed.plot.areas[0], { p: 1, b: 2 });
  assert.ok(Math.abs(area.value - (4 - 6)) < 1e-9, 'the integral of x^3 - 3x from 0 to 2 is -2');
  const described = math.describe(parsed, { p: -1, b: 1 }, 2);
  assert.deepEqual(described.derivatives, [{ of: 'f', label: "f'(x)", expression: '3 * x^2 - 3', points: [[-2.5, 15.75], [0, -3], [2.5, 15.75]] }]);
  assert.deepEqual(described.tangents, [{ of: 'f', x: -1, y: 2, slope: 0 }]);
  assert.deepEqual(described.areas, [{ of: 'f', from: 0, to: 1, value: -1.25 }]);
  assert.ok(described.y[1] >= 15.75, 'the window fits the derivative too');
  assert.deepEqual(math.checkValues(parsed.plot, { p: -1.5, b: 0.5 }), { ok: true, values: { p: -1.5, b: 0.5 } }, 'tangent and bound sliders are saved like any other');
  // One function: the name may be left out; French spellings read the same.
  const sine = math.parsePlot("y = sin(x)\ny'\ntangente en pi/2\naire sous y de 0 à pi\nx in [-4, 4]");
  assert.ok(sine.ok, sine.error?.message);
  assert.deepEqual([sine.plot.derivatives, sine.plot.tangents[0].of, sine.plot.areas[0].of], [['y'], 'y', 'y']);
  assert.ok(Math.abs(math.describe(sine).areas[0].value - 2) < 1e-9);
  const hole = math.parsePlot('y = 1/x\ntangent at 0\narea from -1 to 1\nx in [-2, 2]');
  assert.deepEqual([math.describe(hole).tangents[0].slope, math.describe(hole).areas[0].value], [null, null], 'undefined is never a number');
});

test('calculus lines are refused whole when they cannot be drawn exactly', () => {
  const cases = {
    "f(x) = x^2\nf'(x) = 2x": 'derivative', "f(x) = x^2\ng'(x)": 'unknown_name', "f(x) = x^2\nf'(x)\nf'(x)": 'duplicate',
    'f(x) = x\ng(x) = x\ntangent at 1': 'line', 'f(x) = x\ntangent f at 12': 'range', 'f(x) = x\ntangent f at p\np = 0 in [-20, 20]': 'range',
    'f(x) = x\ntangent f at q': 'number', 'f(x) = x\ntangent f at 1\ntangent f at 1': 'duplicate',
    'f(x) = x\narea f from 0 to 11': 'range', 'f(x) = x\narea h from 0 to 1': 'unknown_name',
    ['f(x) = x\n' + [-2, -1, 0, 1, 2].map(at => `tangent f at ${at}`).join('\n')]: 'tangents',
    ['f(x) = x\n' + [1, 2, 3, 4, 5].map(to => `area f from 0 to ${to}`).join('\n')]: 'areas',
  };
  for (const [body, code] of Object.entries(cases)) assert.equal(math.parsePlot(body).error?.code, code, body);
  assert.match(math.parsePlot("f(x) = x^2\nf'(x) = 2x").error.message, /Core computes the derivative/);
  assert.match(math.parsePlot('f(x) = x\ntangent f at p\np = 0 in [-20, 20]').error.message, /inside the x window \[-10, 10\]/);
});

test('a function may use another of its block, never in a circle', () => {
  const chain = math.parsePlot("f(x) = x^2\ng(x) = f(x - 1) + 1\nh(x) = f'(2x)\nx in [-3, 3]");
  assert.ok(chain.ok, chain.error?.message);
  assert.ok(chain.references);
  assert.deepEqual(chain.plot.functions.map(fn => fn.expression), ['x^2', 'f(x - 1) + 1', "f'(2 * x)"], 'the formulas read as written');
  assert.deepEqual(math.describe(chain, {}, 2).functions.map(fn => fn.points[2]), [[3, 9], [3, 5], [3, 12]], 'drawn from the substituted formulas');
  assert.equal(math.parsePlot(COMPARE).references, false);
  const cases = {
    'f(x) = g(x)\ng(x) = f(x)': 'cycle', 'f(x) = f(x - 1)': 'cycle', 'y = x\ng(x) = y + 1': 'unknown_name',
    'f(x) = x\ng(x) = f * 2': 'syntax', 'f(x) = x*x*x*x*x*x*x*x\ng(x) = f(f(x))\nh(x) = g(g(x))\nk(x) = h(h(x))': 'too_complex',
  };
  for (const [body, code] of Object.entries(cases)) assert.equal(math.parsePlot(body).error?.code, code, body);
  assert.match(math.parsePlot('f(x) = g(x)\ng(x) = f(x)').error.message, /in a circle: f\(x\) → g\(x\) → f\(x\)/);
  assert.match(math.parsePlot('f(x) = x\ng(x) = h(x)').error.message, /Declare a function h\(x\) = … or a parameter/);
});

test('the points come from the formula with the current slider values, gaps where it is undefined', () => {
  const wave = math.parsePlot(WAVE);
  const described = math.describe(wave, { a: 2.5 });
  assert.equal(described.parameters[0].value, 2.5);
  assert.equal(described.functions[0].points.length, 9);
  assert.deepEqual(described.functions[0].points[2], [Number(math.formatNumber(-Math.PI)), 0]);
  const quarter = math.sample(wave.trees[0], { ...wave.plot, x: [Math.PI / 4, Math.PI / 4 + 1] }, { a: 2.5 }, 1)[0];
  assert.ok(Math.abs(quarter[1] - 2.5) < 1e-12, 'a * sin(b * pi/4) with a = 2.5, b = 2');
  const root = math.parsePlot('y = sqrt(x)\nx in [-4, 4]');
  const points = math.sample(root.trees[0], root.plot, {}, 8);
  assert.deepEqual(points.slice(0, 4).map(point => point[1]), [null, null, null, null]);
  assert.equal(points[8][1], 2);
  const tangent = math.parsePlot('y = tan(x)\nx in [-3, 3]');
  const window = math.fitY(math.sample(tangent.trees[0], tangent.plot), tangent.plot);
  assert.ok(window[1] - window[0] < 200, 'the fitted window does not chase the asymptotes');
});

const channel = (text, options = {}) => {
  const channels = createReplyChannels({ allowMath: true, ...options });
  for (let i = 0; i < text.length; i += 7) channels.push(text.slice(i, i + 7));
  return channels.end();
};

test('a parametric curve is written in t and drawn from its formulas, alone or beside functions', () => {
  const circle = math.parsePlot(CIRCLE);
  assert.ok(circle.ok, circle.error?.message);
  assert.equal(circle.plot.schema, 'agentx.math-plot.v4');
  assert.deepEqual(circle.plot.curves, [{ name: 'c', label: 'c(t)', x: 'r * cos(t)', y: 'r * sin(t)' }]);
  assert.deepEqual(circle.plot.t, [0, 2 * Math.PI], 't runs over one turn by default');
  assert.equal(circle.plot.x, undefined, 'curves alone are framed around themselves');
  assert.equal(circle.text, 'c(t) = (r * cos(t), r * sin(t))\nr = 2 in [0.5, 3]\nt in [0, 6.283185307]');
  const again = math.parsePlot(circle.text).plot;
  assert.deepEqual(again.curves, circle.plot.curves, 'the canonical text parses back to the same curve');
  assert.ok(Math.abs(again.t[1] - 2 * Math.PI) < 1e-9, 'and the same range, to ten digits');
  for (const point of math.sampleCurve(circle.curveTrees[0], circle.plot, { r: 3 })) assert.ok(Math.abs(Math.hypot(...point) - 3) < 1e-9);
  const fitted = math.windowsOf(circle, { r: 3 });
  assert.ok(fitted.x[0] < -3 && fitted.x[1] > 3 && fitted.y[1] > 3, 'the window follows the slider');
  // A curve may use the block's functions; with functions the x window is theirs.
  const mixed = math.parsePlot('f(x) = x^2\nc(t) = (t, f(t) + 1)\nt in [-2, 2]\nx in [-3, 3]');
  assert.ok(mixed.ok, mixed.error?.message);
  assert.deepEqual(math.sampleCurve(mixed.curveTrees[0], mixed.plot, {}, 4), [[-2, 5], [-1, 2], [0, 1], [1, 2], [2, 5]]);
  assert.ok(math.windowsOf(mixed).y[1] >= 5, 'y fits the curve too');
  const described = math.describe(circle, { r: 1 }, 4);
  assert.deepEqual(described.curves[0].points.map(([t, x, y]) => [t, x, y]),
    [[0, 1, 0], [1.570796327, 0, 1], [3.141592654, -1, 0], [4.71238898, 0, -1], [6.283185307, 1, 0]]);
  assert.deepEqual(described.t, [0, 6.283185307]);
});

test('curve lines are refused whole when they cannot be drawn exactly', () => {
  const refused = {
    'c(t) = (cos(x), sin(t))': /written in t/,
    'c(t) = (cos(t))': /two formulas in t/,
    'f(x) = x\nc(t) = (t, t)\ntangent c at 1': /not on the curve/,
    'y = x\nt in [0, 1]': /goes with a curve/,
    'f(x) = x\ng(x) = x\nh(x) = x\nc(t) = (t, t)\nd(t) = (t, t)': /At most 4 functions and curves/,
    'c(t) = (t, g(t))': /./,
    't(t) = (t, t)': /./,
  };
  for (const [body, message] of Object.entries(refused)) {
    const parsed = math.parsePlot(body);
    assert.equal(parsed.ok, false, body);
    assert.match(parsed.error.message, message, body);
  }
});

test('a surface z = f(x, y) is computed on a grid from its formula; a block holds only surfaces', () => {
  const saddle = math.parsePlot(SADDLE);
  assert.ok(saddle.ok, saddle.error?.message);
  assert.deepEqual(saddle.plot, { schema: 'agentx.math-plot.v4', kind: 'surfaces', surfaces: [{ name: 'z', label: 'z', expression: 'x^2 - y^2' }],
    parameters: [], x: [-2, 2], y: [-2, 2] });
  assert.equal(saddle.text, SADDLE);
  const { xs, ys, rows } = math.sampleSurface(saddle.trees[0], saddle.plot, {}, 4);
  assert.deepEqual([xs, ys], [[-2, -1, 0, 1, 2], [-2, -1, 0, 1, 2]]);
  assert.deepEqual(rows[2], [4, 1, 0, 1, 4], 'rows[j][i] is the height at (xs[i], ys[j])');
  assert.deepEqual(rows.map(row => row[2]), [-4, -1, 0, -1, -4]);
  assert.deepEqual(math.windowsOf(saddle).z, [-4.64, 4.64], 'z fits every height, peaks included');
  const pair = math.parsePlot('f(x, y) = a*sin(x)*cos(y)\ng(x, y) = 0\na = 1 in [0, 2]');
  assert.ok(pair.ok, pair.error?.message);
  assert.deepEqual(pair.plot.surfaces.map(row => row.label), ['f(x, y)', 'g(x, y)']);
  assert.deepEqual([pair.plot.x, pair.plot.y, pair.plot.z], [[-5, 5], [-5, 5], undefined], 'the ground defaults to [-5, 5]');
  const fixed = math.parsePlot(`${SADDLE}\nz in [-1, 1]`);
  assert.deepEqual(math.windowsOf(fixed).z, [-1, 1], 'a declared z window is kept as written');
  const root = math.sampleSurface(math.parsePlot('z = sqrt(x)').trees[0], { parameters: [], x: [-1, 1], y: [-1, 1] }, {}, 2);
  assert.deepEqual(root.rows[0], [null, 0, 1], 'undefined heights stay undefined, never filled in');
  const described = math.describe(saddle);
  assert.equal(described.kind, 'surfaces');
  assert.equal(described.surfaces[0].points.length, 25, 'a coarse grid for the reader, never a table to read out');
  assert.deepEqual(described.surfaces[0].points[12], [0, 0, 0]);
  const refused = {
    'z = x + y\nf(x) = x': /only surfaces/,
    'z = x + y\nc(t) = (t, t)': /only surfaces/,
    'f(x, y) = x\ng(x, y) = y\nh(x, y) = x*y': /At most 2 surfaces/,
    'z = t*x': /./,
    'f(x, y) = x\ng(x, y) = f(x, y)': /./,
    'z = a*x\nz = 1 in [0, 2]': /z/,
    'f(x, y) = z*x\nz = 1 in [0, 2]': /height/,
    'y = x\nz in [0, 1]': /goes with a surface/,
    'z = x\nt in [0, 1]': /goes with a curve/,
  };
  for (const [body, message] of Object.entries(refused)) {
    const parsed = math.parsePlot(body);
    assert.equal(parsed.ok, false, body);
    assert.match(parsed.error.message, message, body);
  }
});

test('saved slider positions must name every slider and stay inside its range; nothing is clamped', () => {
  const { plot } = math.parsePlot(WAVE);
  assert.deepEqual(math.checkValues(plot, { b: 3, a: -2.5 }), { ok: true, values: { a: -2.5, b: 3 } });
  assert.deepEqual(math.checkValues(plot, { a: -3, b: 4 }).ok, true, 'the range ends are allowed');
  for (const values of [null, [], 'a=1', { a: 1 }, { a: 1, b: 2, c: 3 }, { a: 1, x: 2 }, { a: '1', b: 2 },
    { a: Number.NaN, b: 2 }, { a: Infinity, b: 2 }, { a: 3.01, b: 2 }, { a: 1, b: 0.4 }]) {
    const checked = math.checkValues(plot, values);
    assert.equal(checked.ok, false, JSON.stringify(values));
    assert.equal(checked.error.code, 'values');
  }
  assert.equal(math.checkValues(math.parsePlot('y = x^2').plot, {}).ok, false, 'a plot without sliders keeps nothing');
});

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
  assert.match(contract(), /compare up to four functions/);
  const example = contract().match(/<show kind="math" title="short title">(f\(x\)[^<]+)<\/show>/)[1];
  assert.ok(math.parsePlot(example).ok, 'the contract example is valid');
  const calculus = contract().match(/<show kind="math" title="short title">(f\(x\) = x\^3[^<]+)<\/show>/)[1];
  const read = math.parsePlot(calculus);
  assert.ok(read.ok && read.plot.derivatives && read.plot.tangents && read.plot.areas, 'the calculus example is valid and uses all three');
  const curve = math.parsePlot(contract().match(/<show kind="math" title="short title">(c\(t\)[^<]+)<\/show>/)[1]);
  assert.ok(curve.ok && curve.plot.curves.length === 1, 'the curve example is valid');
  const surface = math.parsePlot(contract().match(/<show kind="math" title="short title">(z = [^<]+)<\/show>/)[1]);
  assert.ok(surface.ok && surface.plot.kind === 'surfaces', 'the surface example is valid');
  assert.doesNotMatch(contract(), /cannot use another function/);
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
  assert.ok(!selected.math.functions[0].points.some(([, y]) => y === 999), 'browser-supplied numbers are ignored');
  const compared = presentationEvidence([{ ...row, text: math.plotText(math.parsePlot(COMPARE).plot, { a: -1 }) }], screenPages);
  assert.deepEqual(compared.math.functions.map(fn => fn.label), ['f(x)', 'g(x)']);
  assert.deepEqual(compared.math.functions[1].points.at(-1), [3, -2], 'Core computes each compared curve itself');
  const calculus = presentationEvidence([{ ...row, text: math.plotText(math.parsePlot(CALCULUS).plot, { p: 2, b: 1 }),
    math: { tangents: [{ of: 'f', x: 2, y: 2, slope: 99 }], areas: [{ of: 'f', from: 0, to: 1, value: 99 }] } }], screenPages);
  assert.deepEqual(calculus.math.tangents, [{ of: 'f', x: 2, y: 2, slope: 9 }], 'the slope is Core\'s, not the page\'s');
  assert.deepEqual(calculus.math.areas, [{ of: 'f', from: 0, to: 1, value: -1.25 }]);
  assert.equal(calculus.math.derivatives[0].expression, '3 * x^2 - 3');
  const surface = presentationEvidence([{ ...row, text: SADDLE, math: { surfaces: [{ points: [[0, 0, 99]] }] } }], screenPages);
  assert.equal(surface.math.kind, 'surfaces');
  assert.deepEqual(surface.math.surfaces[0].points[12], [0, 0, 0], 'the heights are Core\'s, not the page\'s');
  const curve = presentationEvidence([{ ...row, text: math.plotText(math.parsePlot(CIRCLE).plot, { r: 1 }) }], screenPages);
  assert.deepEqual(curve.math.curves[0].points[1], [0.7853981634, 0.7071067812, 0.7071067812]);
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

test('Famille gets the same math card through a short, child-appropriate contract', () => {
  const family = contract({ family: true, math: true }), adult = contract();
  assert.match(family, /kind="math"/);
  assert.match(family, /Start simple for a child/);
  assert.match(family, /cube picture by themselves/);
  assert.doesNotMatch(family, /kind="secret"|\|secret/, 'Famille still has no secrets');
  const famillyMath = family.slice(family.indexOf('Counting and additions'), family.indexOf('current presentation.') + 21);
  const adultMath = adult.slice(adult.indexOf('To draw a function'), adult.indexOf('beside your answer.') + 19);
  assert.ok(famillyMath.length < adultMath.length / 2, `the family addition stays short (${famillyMath.length} vs ${adultMath.length})`);
  const examples = [...family.matchAll(/<show kind="math" title="short title">([^<]+)<\/show>/g)].map(match => math.parsePlot(match[1]));
  assert.equal(examples.length, 2);
  assert.ok(examples.every(row => row.ok), 'every family example is valid');
  assert.equal(examples[0].plot.parameters.length, 1, 'the first example is one curve and one slider');
  assert.ok(examples[1].plot.derivatives && examples[1].plot.tangents, 'the second example shows the derivative and a tangent');
  assert.doesNotMatch(contract({ family: true }), /kind="math"/, 'the KidX reader keeps words only');
  const drawn = channel(`Regarde la droite. <show kind="math" title="Une droite">y = a*x + 1\na = 2 in [-3, 3]\nx in [-5, 5]</show> Bouge a.`, { allowMath: true });
  assert.equal(drawn.display[0].kind, 'math');
  assert.equal(drawn.display[0].link, undefined, 'a math card carries no link');
});

test('Famille draws the model\'s math card; the KidX reader keeps it as code', async () => {
  const reply = 'Une parabole, c’est une courbe en forme de bol. <show kind="math" title="Un bol">y = a*x^2\na = 1 in [-3, 3]\nx in [-3, 3]</show> Bouge a pour l’ouvrir.';
  const h = harness({ packId: 'kidx_nestor', backend: 'agentx', response: reply });
  const events = await streamedTurn(h, 'Montre-moi une parabole');
  assert.equal(h.sent.length, 1, 'the model answers');
  assert.match(h.sent[0].prefix, /kind="math"/, 'the family model is told how to write a math block');
  assert.match(h.sent[0].prefix, /Start simple for a child/);
  const shown = events.find(row => row.type === 'show')?.block;
  assert.deepEqual([shown?.kind, shown?.title], ['math', 'Un bol']);
  assert.equal(shown.body, math.parsePlot('y = a*x^2\na = 1 in [-3, 3]\nx in [-3, 3]').text);
  assert.doesNotMatch(events.filter(row => row.type === 'delta').map(row => row.delta).join(''), /x\^2|\[-3/);
  assert.equal(events.some(row => row.type === 'scene'), false, 'no cube picture for a curve');

  const reader = harness({ packId: 'kidx_reader', backend: 'agentx', response: reply });
  const read = await streamedTurn(reader, 'Que veut dire parabole ?');
  assert.doesNotMatch(reader.sent[0].prefix, /kind="math"/);
  assert.equal(read.find(row => row.type === 'show')?.block.kind, 'code');
});

test('Famille keeps its immediate cube answer without inference', async () => {
  const h = harness({ packId: 'kidx_nestor', backend: 'agentx' });
  const events = await streamedTurn(h, 'Combien font 8 + 5 ?');
  assert.equal(events.find(row => row.type === 'scene')?.scene.kind, 'add');
  assert.equal(h.sent.length, 0);
});
