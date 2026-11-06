/* Math Lab (#1270): the formula grammar Nestor may draw, shared by Core and the
   browser. A tokenizer and a recursive-descent parser build a small tree that
   is evaluated node by node; nothing is ever handed to eval or Function.
   The picture computes every point from the formula, never from the model's
   numbers, so it stays right even when the explanation is wrong. */
(function (root) {
  'use strict';
  // v2 (phase 2): one to four functions per block, compared on the same axes.
  const SCHEMA = 'agentx.math-plot.v2';
  const LIMITS = Object.freeze({ body: 1200, expression: 240, tokens: 160, nodes: 200, depth: 24, parameters: 6,
    functions: 4, magnitude: 1e6, samples: 480 });
  const FUNCTIONS = Object.freeze({ sin: Math.sin, cos: Math.cos, tan: Math.tan, exp: Math.exp, log: Math.log, ln: Math.log,
    sqrt: Math.sqrt, abs: Math.abs });
  const CONSTANTS = Object.freeze({ pi: Math.PI, e: Math.E });
  // x is the variable; y and t are reserved for surfaces and parametric curves.
  const RESERVED = new Set(['x', 'y', 't', 'e']);
  // A function is "y" or named by one letter: f(x), g(x)… never x, t or the constant e.
  const FUNCTION_LINE = /^(?:(y)|([a-z])\s*\(\s*x\s*\))\s*=\s*(.+)$/i;
  const DEFAULT_X = Object.freeze([-10, 10]);
  const WORDS = Object.freeze([...Object.keys(FUNCTIONS), 'pi'].sort((a, b) => b.length - a.length));

  const failure = (code, message) => ({ ok: false, error: { code, message } });

  // Spellings models and people write for the same operators.
  function normalize(source) {
    return String(source).replace(/\*\*/g, '^').replace(/[×·⋅∙]/g, '*').replace(/÷/g, '/').replace(/[−–—]/g, '-')
      .replace(/π/g, 'pi').replace(/²/g, '^2').replace(/³/g, '^3');
  }

  function tokenize(source, names) {
    const text = normalize(source), tokens = [];
    let i = 0;
    while (i < text.length) {
      const char = text[i];
      if (/\s/.test(char)) { i += 1; continue; }
      const number = /^(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?/.exec(text.slice(i));
      // "2e" is two times e, not an unfinished exponent; the regex requires digits after e.
      if (number) { tokens.push({ type: 'number', value: Number(number[0]) }); i += number[0].length; }
      else if (/[a-z]/i.test(char)) {
        const word = /^[a-z]+/i.exec(text.slice(i))[0].toLowerCase();
        // Known words first (sin, sqrt, pi…), then single-letter names: "ax" is a·x.
        let j = 0;
        while (j < word.length) {
          const rest = word.slice(j);
          const name = WORDS.find(known => rest.startsWith(known)) || rest[0];
          if (FUNCTIONS[name]) tokens.push({ type: 'function', value: name });
          else if (name in CONSTANTS) tokens.push({ type: 'constant', value: name });
          else if (names.has(name)) tokens.push({ type: 'name', value: name });
          else return failure('unknown_name', `Unknown name "${name}". Declare a parameter on its own line, for example: ${name} = 1 in [-5, 5]`);
          j += name.length;
        }
        i += word.length;
      } else if ('+-*/^(),'.includes(char)) { tokens.push({ type: char }); i += 1; }
      else if (char === '|') { tokens.push({ type: '|' }); i += 1; }
      else return failure('character', `Unsupported character "${char}"`);
      if (tokens.length > LIMITS.tokens) return failure('too_long', 'The formula is too long');
    }
    return { ok: true, tokens };
  }

  // expression := term (('+'|'-') term)*
  // term       := unary (('*'|'/'|implicit) unary)*
  // unary      := ('+'|'-') unary | power
  // power      := atom ('^' unary)?          (right-associative; -x^2 is -(x^2))
  // atom       := number | constant | name | function '(' expression ')' | '(' expression ')' | '|' expression '|'
  function parseTokens(tokens) {
    let index = 0, nodes = 0;
    const peek = () => tokens[index];
    const take = type => (peek() && peek().type === type ? tokens[index++] : null);
    const node = (value, depth) => {
      nodes += 1;
      if (nodes > LIMITS.nodes || depth > LIMITS.depth) throw new Error('The formula is too complex');
      return value;
    };
    const startsAtom = token => token && ['number', 'constant', 'name', 'function', '('].includes(token.type);
    function expression(depth) {
      let left = term(depth + 1);
      for (let op = take('+') || take('-'); op; op = take('+') || take('-')) left = node({ op: op.type, args: [left, term(depth + 1)] }, depth);
      return left;
    }
    function term(depth) {
      let left = unary(depth + 1);
      for (;;) {
        const op = take('*') || take('/');
        if (op) { left = node({ op: op.type, args: [left, unary(depth + 1)] }, depth); continue; }
        // Implicit product: 2x, 3sin(x), (x+1)(x-1), a(x-h). Never across a bar.
        if (startsAtom(peek())) { left = node({ op: '*', args: [left, power(depth + 1)] }, depth); continue; }
        return left;
      }
    }
    function unary(depth) {
      const op = take('-') || take('+');
      if (!op) return power(depth);
      const value = unary(depth + 1);
      return op.type === '-' ? node({ op: 'neg', args: [value] }, depth) : value;
    }
    function power(depth) {
      const base = atom(depth + 1);
      return take('^') ? node({ op: '^', args: [base, unary(depth + 1)] }, depth) : base;
    }
    function atom(depth) {
      const token = tokens[index++];
      if (!token) throw new Error('The formula ends too early');
      if (token.type === 'number') return node({ op: 'number', value: token.value }, depth);
      if (token.type === 'constant') return node({ op: 'constant', name: token.value }, depth);
      if (token.type === 'name') return node({ op: 'name', name: token.value }, depth);
      if (token.type === 'function') {
        if (!take('(')) throw new Error(`Write ${token.value}(…) with parentheses`);
        const arg = expression(depth + 1);
        if (!take(')')) throw new Error('A closing parenthesis is missing');
        return node({ op: 'call', name: token.value, args: [arg] }, depth);
      }
      if (token.type === '(') {
        const inner = expression(depth + 1);
        if (!take(')')) throw new Error('A closing parenthesis is missing');
        return inner;
      }
      if (token.type === '|') {
        const inner = expression(depth + 1);
        if (!take('|')) throw new Error('A closing | is missing');
        return node({ op: 'call', name: 'abs', args: [inner] }, depth);
      }
      throw new Error(`Unexpected "${token.type}"`);
    }
    const tree = expression(0);
    if (index < tokens.length) throw new Error(`Unexpected "${tokens[index].type === 'number' ? tokens[index].value : tokens[index].value || tokens[index].type}"`);
    return tree;
  }

  /** A validated tree for `source`, using only `names` (and pi, e), or a failure. */
  function parseExpression(source, names = []) {
    const text = String(source ?? '').trim();
    if (!text) return failure('empty', 'The formula is empty');
    if (text.length > LIMITS.expression) return failure('too_long', 'The formula is too long');
    const allowed = new Set(names);
    const lexed = tokenize(text, allowed);
    if (!lexed.ok) return lexed;
    try {
      const tree = parseTokens(lexed.tokens);
      return { ok: true, tree, names: Array.from(usedNames(tree)) };
    } catch (error) { return failure('syntax', error.message); }
  }

  function usedNames(tree, found = new Set()) {
    if (tree.op === 'name') found.add(tree.name);
    (tree.args || []).forEach(arg => usedNames(arg, found));
    return found;
  }

  /** The value of a tree for the given names; NaN where it is undefined. */
  function evaluate(tree, scope = {}) {
    switch (tree.op) {
      case 'number': return tree.value;
      case 'constant': return CONSTANTS[tree.name];
      case 'name': return Object.prototype.hasOwnProperty.call(scope, tree.name) ? Number(scope[tree.name]) : NaN;
      case 'neg': return -evaluate(tree.args[0], scope);
      case 'call': return FUNCTIONS[tree.name](evaluate(tree.args[0], scope));
      case '+': return evaluate(tree.args[0], scope) + evaluate(tree.args[1], scope);
      case '-': return evaluate(tree.args[0], scope) - evaluate(tree.args[1], scope);
      case '*': return evaluate(tree.args[0], scope) * evaluate(tree.args[1], scope);
      case '/': return evaluate(tree.args[0], scope) / evaluate(tree.args[1], scope);
      case '^': return Math.pow(evaluate(tree.args[0], scope), evaluate(tree.args[1], scope));
      default: return NaN;
    }
  }

  // Readable canonical text: explicit operators, minimal parentheses.
  const PRECEDENCE = { '+': 1, '-': 1, '*': 2, '/': 2, neg: 3, '^': 4 };
  function format(tree, parent = 0, right = false) {
    const wrap = (text, level) => (level < parent || (right && level === parent && level !== 4) ? `(${text})` : text);
    switch (tree.op) {
      case 'number': return formatNumber(tree.value);
      case 'constant': case 'name': return tree.name;
      case 'call': return `${tree.name}(${format(tree.args[0])})`;
      case 'neg': return wrap(`-${format(tree.args[0], PRECEDENCE.neg)}`, PRECEDENCE.neg);
      case '^': return wrap(`${format(tree.args[0], PRECEDENCE['^'] + 1)}^${format(tree.args[1], PRECEDENCE['^'])}`, PRECEDENCE['^']);
      default: {
        const level = PRECEDENCE[tree.op];
        return wrap(`${format(tree.args[0], level)} ${tree.op} ${format(tree.args[1], level, true)}`, level);
      }
    }
  }

  function formatNumber(value) {
    if (!Number.isFinite(value)) return 'NaN';
    // Ten significant digits: 0.1 + 0.2 reads 0.3, a tiny coefficient is kept.
    const rounded = Number(value.toPrecision(10));
    return String(Object.is(rounded, -0) ? 0 : rounded);
  }

  // A bound or value may itself be a constant formula: -2*pi, pi/2, sqrt(2).
  function constant(source, label) {
    const parsed = parseExpression(source, []);
    if (!parsed.ok) return { ok: false, error: { code: 'number', message: `${label}: ${parsed.error.message}` } };
    const value = evaluate(parsed.tree);
    if (!Number.isFinite(value) || Math.abs(value) > LIMITS.magnitude) return failure('number', `${label} must be a finite number`);
    return { ok: true, value };
  }

  const RANGE = /^\[\s*([^,\]]+?)\s*[,;]\s*([^\]]+?)\s*\]$|^([^.\s][^\s]*?)\s*\.\.\s*(\S+)$/;
  function range(source, label) {
    const match = RANGE.exec(String(source).trim());
    if (!match) return failure('range', `${label}: write the range as [min, max]`);
    const low = constant(match[1] ?? match[3], label), high = constant(match[2] ?? match[4], label);
    if (!low.ok) return low;
    if (!high.ok) return high;
    if (!(low.value < high.value)) return failure('range', `${label}: the minimum must be below the maximum`);
    return { ok: true, value: [low.value, high.value] };
  }

  /**
   * A math block's body, one statement per line:
   *   y = a*sin(b*x)        or f(x) = …, g(x) = …: one to four functions, compared on the same axes
   *   a = 1 in [-3, 3]      a parameter, its value and slider range
   *   x in [-2*pi, 2*pi]    optional horizontal window (default [-10, 10])
   *   y in [-4, 4]          optional vertical window (default: fitted to the curve)
   */
  function parsePlot(body) {
    const text = String(body ?? '');
    if (text.length > LIMITS.body) return failure('too_long', 'The math block is too long');
    const lines = text.split('\n').map(line => line.trim().replace(/^`+|`+$/g, '').replace(/^[-*•]\s+/, '').replace(/[.;]\s*$/, '').trim())
      .filter(line => line && !/^```/.test(line));
    let xWindow = null, yWindow = null;
    const parameters = [], sources = [];
    for (const line of lines) {
      let match;
      if ((match = /^([xy])\s*(?:in\b|∈)\s*(.+)$/i.exec(line))) {
        const window = range(match[2], `${match[1]} window`);
        if (!window.ok) return window;
        const width = window.value[1] - window.value[0];
        if (width < 1e-6) return failure('range', 'The window is too narrow');
        if (match[1].toLowerCase() === 'x') xWindow = window.value; else yWindow = window.value;
      } else if ((match = FUNCTION_LINE.exec(line))) {
        const name = (match[1] || match[2]).toLowerCase();
        if (['x', 't', 'e'].includes(name)) return failure('reserved', `"${name}" cannot name a function; use f(x), g(x)…`);
        if (sources.some(row => row.name === name)) return failure('duplicate', `Function ${name} is declared twice`);
        sources.push({ name, source: match[3] });
        if (sources.length > LIMITS.functions) return failure('functions', `At most ${LIMITS.functions} functions per block`);
      } else if ((match = /^([a-z])\s*=\s*(.+?)\s*(?:in|∈)?\s*(\[[^\]]*\]|\S+\s*\.\.\s*\S+)$/i.exec(line))) {
        const name = match[1].toLowerCase();
        if (RESERVED.has(name)) return failure('reserved', `"${name}" is reserved and cannot be a parameter`);
        if (parameters.some(row => row.name === name)) return failure('duplicate', `Parameter "${name}" is declared twice`);
        const value = constant(match[2], `Parameter ${name}`);
        if (!value.ok) return value;
        const bounds = range(match[3], `Parameter ${name}`);
        if (!bounds.ok) return bounds;
        if (value.value < bounds.value[0] || value.value > bounds.value[1]) return failure('range', `Parameter ${name} must lie inside its range`);
        parameters.push({ name, value: value.value, min: bounds.value[0], max: bounds.value[1] });
        if (parameters.length > LIMITS.parameters) return failure('parameters', `At most ${LIMITS.parameters} parameters`);
      } else if ((match = /^([a-z])\s*=/i.exec(line))) {
        return failure('range', `Parameter ${match[1].toLowerCase()} needs a slider range, for example: ${match[1].toLowerCase()} = 1 in [-5, 5]`);
      } else return failure('line', `Unrecognised line "${line.slice(0, 60)}". Use y = …, a = 1 in [-5, 5], x in [-10, 10]`);
    }
    if (!sources.length) return failure('no_function', 'Write the function as y = …');
    const clash = sources.find(row => parameters.some(parameter => parameter.name === row.name));
    if (clash) return failure('duplicate', `"${clash.name}" names both a function and a parameter`);
    const names = ['x', ...parameters.map(row => row.name)], functions = [], trees = [];
    for (const row of sources) {
      const parsed = parseExpression(row.source, names);
      if (!parsed.ok) {
        // Functions do not call each other (yet): say so rather than asking for a parameter.
        if (parsed.error.code === 'unknown_name' && sources.some(other => parsed.error.message.startsWith(`Unknown name "${other.name}"`))) {
          return failure('unknown_name', 'A function cannot use another function yet; write its formula out');
        }
        return sources.length > 1 ? failure(parsed.error.code, `${label(row.name)}: ${parsed.error.message}`) : parsed;
      }
      functions.push({ name: row.name, label: label(row.name), expression: format(parsed.tree) });
      trees.push(parsed.tree);
    }
    const plot = { schema: SCHEMA, kind: 'functions', variable: 'x', functions, parameters,
      x: xWindow || DEFAULT_X.slice(), ...(yWindow ? { y: yWindow } : {}) };
    return { ok: true, plot, trees, text: plotText(plot) };
  }

  const label = name => (name === 'y' ? 'y' : `${name}(x)`);

  /** The canonical body for a plot, with `values` replacing the parameters' current values. */
  function plotText(plot, values = {}) {
    const lines = plot.functions.map(fn => `${fn.label} = ${fn.expression}`);
    for (const row of plot.parameters) {
      const value = Number.isFinite(values[row.name]) ? values[row.name] : row.value;
      lines.push(`${row.name} = ${formatNumber(value)} in [${formatNumber(row.min)}, ${formatNumber(row.max)}]`);
    }
    lines.push(`x in [${formatNumber(plot.x[0])}, ${formatNumber(plot.x[1])}]`);
    if (plot.y) lines.push(`y in [${formatNumber(plot.y[0])}, ${formatNumber(plot.y[1])}]`);
    return lines.join('\n');
  }

  /** Points computed from the formula: [x, y] pairs, y null where undefined or off the chart. */
  function sample(tree, plot, values = {}, count = LIMITS.samples) {
    const scope = {};
    for (const row of plot.parameters) scope[row.name] = Number.isFinite(values[row.name]) ? values[row.name] : row.value;
    const [x0, x1] = plot.x, points = [];
    for (let i = 0; i <= count; i += 1) {
      const x = x0 + (x1 - x0) * i / count;
      scope.x = x;
      const y = evaluate(tree, scope);
      points.push([x, Number.isFinite(y) && Math.abs(y) < 1e12 ? y : null]);
    }
    return points;
  }

  /** The vertical window: the declared one, else fitted to the curves (all their points together) without chasing asymptotes. */
  function fitY(points, plot) {
    if (plot.y) return plot.y.slice();
    const ys = points.map(point => point[1]).filter(y => y !== null).sort((a, b) => a - b);
    if (!ys.length) return [-10, 10];
    const at = q => ys[Math.min(ys.length - 1, Math.max(0, Math.round(q * (ys.length - 1))))];
    let low = at(0.02), high = at(0.98);
    if (ys.length < 20) { low = ys[0]; high = ys[ys.length - 1]; }
    if (high - low < 1e-9) { low -= 1; high += 1; }
    const pad = (high - low) * 0.1;
    return [low - pad, high + pad];
  }

  /** What the reader of a plot is told: the formula, values, the window drawn and a few points, all computed here. */
  function describe(parsed, values = {}, count = 8) {
    const { plot, trees } = parsed;
    const parameters = plot.parameters.map(row => ({ ...row, value: Number.isFinite(values[row.name]) ? values[row.name] : row.value }));
    const current = Object.fromEntries(parameters.map(row => [row.name, row.value]));
    // Floating-point residue such as sin(pi) = 1.2e-16 reads as 0.
    const round = value => (value === null ? null : Math.abs(value) < 1e-10 ? 0 : Number(formatNumber(value)));
    const y = fitY(trees.flatMap(tree => sample(tree, plot, current)), plot).map(round);
    return { schema: SCHEMA, functions: plot.functions.map((fn, index) => ({ ...fn,
      points: sample(trees[index], plot, current, count).map(([px, py]) => [round(px), round(py)]) })), parameters, x: plot.x.slice(), y };
  }

  const api = Object.freeze({ SCHEMA, LIMITS, FUNCTIONS: Object.keys(FUNCTIONS), parseExpression, evaluate, format, formatNumber,
    parsePlot, plotText, sample, fitY, describe });
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.AgentXMathExpression = api;
})(typeof window === 'undefined' ? globalThis : window);
