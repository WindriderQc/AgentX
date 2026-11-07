#!/usr/bin/env node
'use strict';

// Math Lab (#1270): regenerate the grammar vectors shared with GraphysX-Web.
// Inputs already in the file are kept; every answer is recomputed from this
// repository's grammar (core/public/js/math-expression.js), and the rows below
// are added when missing. Copy the result to GraphysX-Web as
// test/fixtures/math-expression-vectors.json.
//
//   node core/scripts/math-expression-vectors.js          rewrite the file
//   node core/scripts/math-expression-vectors.js --check  fail if it is stale
const fs = require('node:fs');
const path = require('node:path');
const math = require('../public/js/math-expression');

const FILE = path.join(__dirname, '../public/js/math-expression.vectors.json');
const XS = [-2, -0.5, 0, 1, 3];
const PARAMETERS = { a: 1.5, b: -1, c: 0.5, h: 1.5, k: -1 };

// Phase 3: derivatives of every rule, and functions that use other functions.
const EXPRESSIONS = [
  ['cos(2x)', ['x']], ['x^x', ['x']], ['sqrt(x)', ['x']], ['abs(x)', ['x']], ['2^x', ['x']], ['e^(2x)', ['x']],
  ['x*sin(x)', ['x']], ['sin(x)/x', ['x']], ['x^-2', ['x']], ['x^a', ['x', 'a']], ['x^0.5', ['x']], ['(3x+1)^2', ['x']],
  ['-(x-3)', ['x']], ['exp(x)', ['x']], ['x/3', ['x']], ['2 - x', ['x']], ['a*cos(x)^2', ['x', 'a']], ['sin(x)^2 + cos(x)^2', ['x']],
  ['log(x^2 + 1)', ['x']], ['1/(1 + exp(-x))', ['x']], ['x^3/3 - x', ['x']], ['-x/(x^2 + 1)', ['x']], ['h(x)', ['x']],
];
const SYSTEMS = [
  [['f', 'x^2'], ['g', 'f(x - 1) + 1']],
  [['f', 'x^3 - 3x'], ['g', "f'(x)"], ['h', "f'(2x) + a"]],
  [['f', 'sin(x)'], ['g', '2f(x) + f(pi/2)']],
  [['f', 'x + 1'], ['g', 'f(f(x))'], ['h', 'g(f(x)) * a']],
  [['y', 'x^2'], ['f', 'x + 1']],
  [['f', 'g(x)'], ['g', 'f(x)']],
  [['f', 'f(x) + 1']],
  [['f', 'x'], ['g', "g'(x)"]],
  [['f', 'x*x*x*x*x*x*x*x'], ['g', 'f(f(x))'], ['h', 'g(g(x))'], ['k', 'h(h(x))']],
  [['f', 'x'], ['g', 'f * 2']],
  [['f', 'x'], ['g', 'q(x)']],
  [['y', 'x'], ['g', 'y + 1']],
];
// Phase 3, v4: parametric curves (in t, with the parameter a), which may use the block's functions.
const CURVES = [
  [[], 'cos(t)', 'sin(t)'],
  [[], 'a*cos(3t)', '2sin(2t) + a'],
  [[['f', 'x^2']], 't', 'f(t) + 1'],
  [[['f', 'x^3 - 3x']], "f'(t)", 'f(t)'],
  [[['f', 'sqrt(x)']], 't - 1', 'f(t - 1)'],
  [[], 'cos(x)', 'sin(t)'],
  [[], 'q*t', 't'],
  [[['y', 'x^2']], 't', 'y(t)'],
];
const TS = [-2, 0, 0.5, Math.PI];
// Windows fitted around values (curve coordinates, surface heights): spread, peaked, asymptote, flat.
const RANGES = [
  [1, 2, 3],
  Array.from({ length: 41 }, (_, i) => Math.exp(-(((i - 20) / 4) ** 2))),
  Array.from({ length: 41 }, (_, i) => Math.tan(-1.56 + 3.12 * i / 40)),
  Array.from({ length: 30 }, () => 2),
  [null, 4, null, -1],
  [],
];

// Non-finite answers are written as text: "NaN", "Infinity", "-Infinity".
const answer = value => (Number.isFinite(value) ? value : String(value));
const scopes = names => (names.includes('x') ? XS.map(x => ({ x, ...pick(names) })) : [pick(names)]);
const pick = names => Object.fromEntries(names.filter(name => name in PARAMETERS).map(name => [name, PARAMETERS[name]]));

function expressionRow(source, names) {
  const parsed = math.parseExpression(source, names);
  if (!parsed.ok) return { source, names, error: parsed.error.code };
  const row = { source, names, format: math.format(parsed.tree),
    evaluations: scopes(names).map(scope => ({ scope, value: answer(math.evaluate(parsed.tree, scope)) })) };
  if (names.includes('x')) {
    const derivative = math.derive(parsed.tree);
    row.derivative = math.format(derivative);
    row.derivativeEvaluations = scopes(names).map(scope => ({ scope, value: answer(math.evaluate(derivative, scope)) }));
  }
  return row;
}

function systemRow(functions) {
  const names = ['x', 'a'];
  const rows = functions.map(([name, source]) => ({ name, source }));
  const read = math.parseFunctions(rows, names);
  if (!read.ok) return { functions: rows, names, error: read.error.code, failing: read.name };
  return { functions: rows, names, formats: read.functions.map(row => math.format(row.tree)),
    evaluations: scopes(names).map(scope => ({ scope, values: read.functions.map(row => answer(math.evaluate(row.expanded, scope))) })) };
}

function curveRow([functions, x, y]) {
  const names = ['t', 'a'];
  const rows = functions.map(([name, source]) => ({ name, source }));
  const row = { functions: rows, names, x, y };
  const read = math.parseFunctions(rows, ['x', 'a']);
  if (!read.ok) return { ...row, error: read.error.code };
  const callable = rows.filter(fn => fn.name !== 'y').map(fn => fn.name), trees = [];
  for (const source of [x, y]) {
    const parsed = math.parseExpression(source, names, callable);
    if (!parsed.ok) return { ...row, error: parsed.error.code };
    const expanded = math.expandCalls(parsed.tree, read.functions);
    if (!expanded.ok) return { ...row, error: expanded.error.code };
    trees.push({ tree: parsed.tree, expanded: expanded.tree });
  }
  return { ...row, formats: trees.map(item => math.format(item.tree)),
    evaluations: TS.map(t => ({ scope: { t, a: PARAMETERS.a }, values: trees.map(item => answer(math.evaluate(item.expanded, { t, a: PARAMETERS.a }))) })) };
}

function fitRow(row) {
  const parsed = math.parseExpression(row.expression, ['x', ...row.parameters.map(p => p.name)]);
  const plot = { parameters: row.parameters, x: row.x, ...(row.declared ? { y: row.declared } : {}) };
  return { ...row, fitted: math.fitY(math.sample(parsed.tree, plot, {}, row.samples), plot) };
}

function build(previous) {
  const known = new Set(previous.expressions.map(row => row.source));
  const expressions = [...previous.expressions.map(row => [row.source, row.names]), ...EXPRESSIONS.filter(([source]) => !known.has(source))];
  const previousSystems = previous.systems || [];
  const knownSystems = new Set(previousSystems.map(row => JSON.stringify(row.functions.map(fn => [fn.name, fn.source]))));
  const systems = [...previousSystems.map(row => row.functions.map(fn => [fn.name, fn.source])),
    ...SYSTEMS.filter(row => !knownSystems.has(JSON.stringify(row)))];
  return {
    schema: 'agentx.math-expression-vectors.v1',
    note: 'Shared by AgentX (core/public/js/math-expression.js) and GraphysX-Web (src/math-expression.ts). Change both sides together; regenerate with node core/scripts/math-expression-vectors.js.',
    expressions: expressions.map(([source, names]) => expressionRow(source, names)),
    systems: systems.map(systemRow),
    fits: previous.fits.map(fitRow),
    curves: CURVES.map(curveRow),
    ranges: RANGES.map(values => ({ values, fitted: math.fitRange(values) })),
  };
}

const current = fs.readFileSync(FILE, 'utf8');
const next = JSON.stringify(build(JSON.parse(current)), null, 1) + '\n';
if (process.argv.includes('--check')) {
  if (next !== current) { console.error('math-expression.vectors.json is stale: run node core/scripts/math-expression-vectors.js'); process.exitCode = 1; }
} else {
  fs.writeFileSync(FILE, next);
  console.log(`Wrote ${path.relative(process.cwd(), FILE)}`);
}
