/* Math Lab (#1270): the formula grammar Nestor may draw, shared by Core and the
   browser. A tokenizer and a recursive-descent parser build a small tree that
   is evaluated node by node; nothing is ever handed to eval or Function.
   The picture computes every point from the formula, never from the model's
   numbers, so it stays right even when the explanation is wrong. */
(function (root) {
  'use strict';
  // v2 (phase 2): one to four functions per block, compared on the same axes.
  // v3 (phase 3): derivatives, tangents, areas, and functions that use other functions.
  // v4 (phase 3): parametric curves c(t) = (x(t), y(t)) beside the functions, and surfaces z = f(x, y).
  const SCHEMA = 'agentx.math-plot.v4';
  const LIMITS = Object.freeze({ body: 1200, expression: 240, tokens: 160, nodes: 200, depth: 24, parameters: 6,
    functions: 4, magnitude: 1e6, samples: 480, tangents: 4, areas: 4, expanded: 4000, derivative: 20000, integral: 1000,
    surfaces: 2, grid: 40 });
  const FUNCTIONS = Object.freeze({ sin: Math.sin, cos: Math.cos, tan: Math.tan, exp: Math.exp, log: Math.log, ln: Math.log,
    sqrt: Math.sqrt, abs: Math.abs });
  const CONSTANTS = Object.freeze({ pi: Math.PI, e: Math.E });
  // x is the variable; y and t are reserved for surfaces and parametric curves.
  const RESERVED = new Set(['x', 'y', 't', 'e']);
  // A function is "y" or named by one letter: f(x), g(x)… never x, t or the constant e.
  const FUNCTION_LINE = /^(?:(y)|([a-z])\s*\(\s*x\s*\))\s*=\s*(.+)$/i;
  // f'(x) or y' alone: draw the derivative, which Core computes from the formula.
  const DERIVATIVE_LINE = /^([a-z])\s*'\s*(?:\(\s*x\s*\))?\s*(=.*)?$/i;
  // tangent f at p, tangent to f at x = 1, tangente à f en p
  const TANGENT_LINE = /^tangente?\s+(?:to\s+|à\s+)?(?:([a-z])(?:\s*\(\s*x\s*\))?\s+)?(?:at|en)\s+(?:x\s*=\s*)?(.+)$/i;
  // area f from a to b, area under f from 0 to 2, aire sous f de a à b
  const AREA_LINE = /^(?:area|aire)\s+(?:(?:under|of|sous|de)\s+)?(?:([a-z])(?:\s*\(\s*x\s*\))?\s+)?(?:from|de)\s+(.+?)\s+(?:to|à)\s+(.+)$/i;
  // c(t) = (cos(t), sin(t)): a parametric curve, its two coordinates in t.
  const CURVE_LINE = /^([a-z])\s*\(\s*t\s*\)\s*=\s*\((.+)\)$/i;
  // z = x^2 - y^2 or f(x, y) = …: a surface over the x, y window.
  const SURFACE_LINE = /^(?:(z)|([a-z])\s*\(\s*x\s*,\s*y\s*\))\s*=\s*(.+)$/i;
  const DEFAULT_X = Object.freeze([-10, 10]);
  const DEFAULT_T = Object.freeze([0, 2 * Math.PI]);
  const DEFAULT_SURFACE = Object.freeze([-5, 5]);
  const WORDS = Object.freeze([...Object.keys(FUNCTIONS), 'pi'].sort((a, b) => b.length - a.length));

  const failure = (code, message) => ({ ok: false, error: { code, message } });

  // Spellings models and people write for the same operators.
  function normalize(source) {
    return String(source).replace(/\*\*/g, '^').replace(/[×·⋅∙]/g, '*').replace(/÷/g, '/').replace(/[−–—]/g, '-')
      .replace(/π/g, 'pi').replace(/²/g, '^2').replace(/³/g, '^3').replace(/[′’]/g, "'");
  }

  // `callables` are the block's functions: f(…) and f'(…) use them, never a product.
  function tokenize(source, names, callables = new Set()) {
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
          else if (callables.has(name)) tokens.push({ type: 'userfn', value: name, prime: false });
          else if (names.has(name)) tokens.push({ type: 'name', value: name });
          // h(x) with no h declared: it may be meant as a function or as a parameter times (x).
          else if (j + 1 === word.length && /^\s*\(/.test(text.slice(i + word.length))) {
            return failure('unknown_name', `Unknown name "${name}". Declare a function ${name}(x) = … or a parameter ${name} = 1 in [-5, 5] on its own line`);
          } else return failure('unknown_name', `Unknown name "${name}". Declare a parameter on its own line, for example: ${name} = 1 in [-5, 5]`);
          j += name.length;
        }
        i += word.length;
      } else if (char === "'" && tokens.length && tokens[tokens.length - 1].type === 'userfn' && !tokens[tokens.length - 1].prime) {
        tokens[tokens.length - 1].prime = true; i += 1;
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
  // atom       := number | constant | name | function '(' expression ')' | userfn ['\''] '(' expression ')'
  //             | '(' expression ')' | '|' expression '|'
  function parseTokens(tokens) {
    let index = 0, nodes = 0;
    const peek = () => tokens[index];
    const take = type => (peek() && peek().type === type ? tokens[index++] : null);
    const node = (value, depth) => {
      nodes += 1;
      if (nodes > LIMITS.nodes || depth > LIMITS.depth) throw new Error('The formula is too complex');
      return value;
    };
    const startsAtom = token => token && ['number', 'constant', 'name', 'function', 'userfn', '('].includes(token.type);
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
        // Implicit product: 2x, 3sin(x), (x+1)(x-1), a(x-h), 2f(x). Never across a bar.
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
      if (token.type === 'function' || token.type === 'userfn') {
        const written = token.value + (token.prime ? "'" : '');
        if (!take('(')) throw new Error(`Write ${written}(…) with parentheses`);
        const arg = expression(depth + 1);
        if (!take(')')) throw new Error('A closing parenthesis is missing');
        if (token.type === 'function') return node({ op: 'call', name: token.value, args: [arg] }, depth);
        return node(token.prime ? { op: 'apply', name: token.value, prime: true, args: [arg] } : { op: 'apply', name: token.value, args: [arg] }, depth);
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

  /** A validated tree for `source`, using only `names` (and pi, e) and the block's `functions`, or a failure. */
  function parseExpression(source, names = [], functions = []) {
    const text = String(source ?? '').trim();
    if (!text) return failure('empty', 'The formula is empty');
    if (text.length > LIMITS.expression) return failure('too_long', 'The formula is too long');
    const allowed = new Set(names);
    const lexed = tokenize(text, allowed, new Set(functions));
    if (!lexed.ok) return lexed;
    try {
      const tree = parseTokens(lexed.tokens);
      return { ok: true, tree, names: Array.from(usedNames(tree)) };
    } catch (error) { return failure('syntax', error.message); }
  }

  // Whether a tree names another function of its block (drawn by GraphysX only from v3).
  const usesFunctions = tree => tree.op === 'apply' || (tree.args || []).some(usesFunctions);

  function usedNames(tree, found = new Set()) {
    if (tree.op === 'name') found.add(tree.name);
    (tree.args || []).forEach(arg => usedNames(arg, found));
    return found;
  }

  /** The value of a tree for the given names; NaN where it is undefined (or still names another function). */
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
      case 'apply': return `${tree.name}${tree.prime ? "'" : ''}(${format(tree.args[0])})`;
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

  // ---------------------------------------------------------------------------------------------
  // Derivatives (phase 3): d/dx of a validated tree, by the usual rules, simplified enough to read.
  // Built only from the tree, so a model's "the slope is 3" never reaches the picture.

  // A negative number is written as a negation, as the parser reads "-2".
  const num = value => (value < 0 ? { op: 'neg', args: [{ op: 'number', value: -value }] } : { op: 'number', value: value === 0 ? 0 : value });
  const valueOf = tree => (tree.op === 'number' ? tree.value : tree.op === 'neg' && tree.args[0].op === 'number' ? -tree.args[0].value : null);
  const hasX = tree => (tree.op === 'name' ? tree.name === 'x' : (tree.args || []).some(hasX));
  // Only numbers and operators: its value is known exactly enough to fold.
  const numeric = tree => tree.op === 'number' || (tree.op !== 'name' && tree.op !== 'constant' && tree.op !== 'call' && tree.op !== 'apply'
    && (tree.args || []).every(numeric));
  const small = value => Number.isInteger(value) && Math.abs(value) <= LIMITS.magnitude;

  // The positive form of a term that reads with a leading minus, or null.
  function negated(tree) {
    if (tree.op === 'neg') return tree.args[0];
    if ((tree.op === '*' || tree.op === '/') && negated(tree.args[0])) return make(tree.op, negated(tree.args[0]), tree.args[1]);
    return null;
  }
  function negate(tree) {
    const value = valueOf(tree);
    if (value !== null) return num(-value);
    if (tree.op === 'neg') return tree.args[0];
    if (tree.op === '*' || tree.op === '/') return make(tree.op, negate(tree.args[0]), tree.args[1]);
    if (tree.op === '-') return make('-', tree.args[1], tree.args[0]);
    return { op: 'neg', args: [tree] };
  }
  // A node with the obvious simplifications: 0 + u, 1 * u, u^1, folded numbers, constants first.
  function make(op, a, b) {
    const va = valueOf(a), vb = valueOf(b);
    switch (op) {
      case '+':
        if (va === 0) return b;
        if (vb === 0) return a;
        if (va !== null && vb !== null) return num(va + vb);
        if (negated(b)) return make('-', a, negated(b));
        return { op, args: [a, b] };
      case '-':
        if (vb === 0) return a;
        if (va === 0) return negate(b);
        if (va !== null && vb !== null) return num(va - vb);
        if (negated(b)) return make('+', a, negated(b));
        return { op, args: [a, b] };
      case '*':
        if (va === 0 || vb === 0) return num(0);
        if (va === 1) return b;
        if (vb === 1) return a;
        if (va === -1) return negate(b);
        if (vb === -1) return negate(a);
        if (va !== null && vb !== null) return num(va * vb);
        if (vb !== null) return make('*', b, a);
        if (b.op === 'neg') return negate(make('*', a, b.args[0]));
        if (b.op === '*') return make('*', make('*', a, b.args[0]), b.args[1]);
        return { op, args: [a, b] };
      case '/':
        if (va === 0) return num(0);
        if (vb === 1) return a;
        if (va !== null && vb !== null && vb !== 0 && small(va / vb)) return num(va / vb);
        // (3 * x^2) / 3 → x^2: a whole coefficient divides out.
        if (vb !== null && vb !== 0 && a.op === '*' && valueOf(a.args[0]) !== null && small(valueOf(a.args[0]) / vb)) {
          return make('*', num(valueOf(a.args[0]) / vb), a.args[1]);
        }
        return { op, args: [a, b] };
      default: // '^'
        if (vb === 0) return num(1);
        if (vb === 1) return a;
        if (va !== null && vb !== null && small(Math.pow(va, vb))) return num(Math.pow(va, vb));
        return { op, args: [a, b] };
    }
  }
  const call = (name, arg) => ({ op: 'call', name, args: [arg] });

  /** d/dx of a tree without references to other functions (see parseFunctions). */
  function derive(tree) {
    const [u, v] = tree.args || [];
    switch (tree.op) {
      case 'number': case 'constant': return num(0);
      case 'name': return num(tree.name === 'x' ? 1 : 0);
      case 'neg': return negate(derive(u));
      case '+': return make('+', derive(u), derive(v));
      case '-': return make('-', derive(u), derive(v));
      case '*':
        if (!hasX(u)) return make('*', u, derive(v));
        if (!hasX(v)) return make('*', v, derive(u));
        return make('+', make('*', derive(u), v), make('*', u, derive(v)));
      case '/':
        if (!hasX(v)) return make('/', derive(u), v);
        return make('/', make('-', make('*', derive(u), v), make('*', u, derive(v))), make('^', v, num(2)));
      case '^': {
        if (!hasX(v)) {
          // Power rule; a plain number exponent gets its n - 1 folded: x^3 → 3 * x^2.
          const n = numeric(v) ? num(evaluate(v)) : v, less = numeric(v) ? num(evaluate(v) - 1) : make('-', v, num(1));
          return make('*', derive(u), make('*', n, make('^', u, less)));
        }
        if (!hasX(u)) {
          // a^v: e^v needs no ln(e).
          const grown = u.op === 'constant' && u.name === 'e' ? tree : make('*', tree, call('ln', u));
          return make('*', derive(v), grown);
        }
        return make('*', tree, make('+', make('*', derive(v), call('ln', u)), make('/', make('*', v, derive(u)), u)));
      }
      case 'call': {
        const du = derive(u);
        switch (tree.name) {
          case 'sin': return make('*', du, call('cos', u));
          case 'cos': return negate(make('*', du, call('sin', u)));
          case 'tan': return make('/', du, make('^', call('cos', u), num(2)));
          case 'exp': return make('*', du, tree);
          case 'log': case 'ln': return make('/', du, u);
          case 'sqrt': return make('/', du, make('*', num(2), tree));
          // Undefined where u = 0, as the corner of |u| is.
          default: return make('*', du, make('/', u, tree));
        }
      }
      default: return num(NaN);
    }
  }

  // How many nodes evaluating a tree visits, shared subtrees counted each time they are reached.
  function weight(tree, memo = new WeakMap()) {
    if (memo.has(tree)) return memo.get(tree);
    const total = 1 + (tree.args || []).reduce((sum, arg) => sum + weight(arg, memo), 0);
    memo.set(tree, total);
    return total;
  }
  // The tree with x replaced by `arg` (shared, not copied).
  function substitute(tree, arg) {
    if (tree.op === 'name') return tree.name === 'x' ? arg : tree;
    return tree.args ? { ...tree, args: tree.args.map(child => substitute(child, arg)) } : tree;
  }

  /**
   * Functions that may use one another: f(x) = x^2, g(x) = f(x - 1) + f'(x).
   * Each `tree` keeps its references, for display; `expanded` replaces them by the function's
   * own formula (a derivative reference by Core's derivative of it), so nothing follows a name
   * while drawing. A function that reaches itself through references is refused.
   * Returns { ok, functions: [{ name, tree, expanded }] } or a failure naming the function.
   */
  function parseFunctions(rows, names) {
    const callable = rows.filter(row => row.name !== 'y').map(row => row.name);
    const parsed = new Map();
    for (const row of rows) {
      const result = parseExpression(row.source, names, callable);
      if (!result.ok) return { ...result, name: row.name };
      parsed.set(row.name, result.tree);
    }
    const expanded = new Map(), visiting = [], memo = new WeakMap();
    const stop = (code, message, name) => { const error = new Error(message); error.code = code; error.fn = name; throw error; };
    function expand(name) {
      if (expanded.has(name)) return expanded.get(name);
      if (visiting.includes(name)) {
        const loop = [...visiting.slice(visiting.indexOf(name)), name].map(row => `${row}(x)`).join(' → ');
        stop('cycle', `Functions cannot use each other in a circle: ${loop}`, visiting[visiting.length - 1]);
      }
      visiting.push(name);
      const tree = inline(parsed.get(name), name);
      visiting.pop();
      expanded.set(name, tree);
      return tree;
    }
    function inline(tree, owner) {
      let result;
      if (tree.op === 'apply') {
        let body = expand(tree.name);
        if (tree.prime) {
          body = derive(body);
          if (weight(body, memo) > LIMITS.derivative) stop('too_complex', `The derivative of ${tree.name}(x) is too large to use`, owner);
        }
        result = substitute(body, inline(tree.args[0], owner));
      } else result = tree.args ? { ...tree, args: tree.args.map(child => inline(child, owner)) } : tree;
      // Checked as it grows, so f(f(f(x))) chains stop before they get large.
      if (weight(result, memo) > LIMITS.expanded) stop('too_complex', 'Using the other functions makes this formula too large to draw', owner);
      return result;
    }
    try {
      for (const row of rows) expand(row.name);
    } catch (error) {
      if (!error.code) throw error;
      return { ...failure(error.code, error.message), name: error.fn };
    }
    return { ok: true, functions: rows.map(row => ({ name: row.name, tree: parsed.get(row.name), expanded: expanded.get(row.name) })) };
  }

  /**
   * `tree` with its references to the block's functions replaced by their formulas, as
   * parseFunctions does for a function: a parametric curve's coordinates may use f(t) or f'(t).
   * `functions` are parseFunctions' rows. Returns { ok, tree } or a failure.
   */
  function expandCalls(tree, functions) {
    const bodies = new Map(functions.map(row => [row.name, row.expanded])), slopes = new Map(), memo = new WeakMap();
    const stop = (code, message) => { const error = new Error(message); error.code = code; return error; };
    function inline(node) {
      let result;
      if (node.op === 'apply') {
        let body = bodies.get(node.name);
        if (node.prime) {
          if (!slopes.has(node.name)) {
            const slope = derive(body);
            if (weight(slope, memo) > LIMITS.derivative) throw stop('too_complex', `The derivative of ${node.name}(x) is too large to use`);
            slopes.set(node.name, slope);
          }
          body = slopes.get(node.name);
        }
        result = substitute(body, inline(node.args[0]));
      } else result = node.args ? { ...node, args: node.args.map(inline) } : node;
      if (weight(result, memo) > LIMITS.expanded) throw stop('too_complex', 'Using the other functions makes this formula too large to draw');
      return result;
    }
    try {
      return { ok: true, tree: inline(tree) };
    } catch (error) {
      if (!error.code) throw error;
      return failure(error.code, error.message);
    }
  }

  // "cos(t), sin(t)" → its two formulas, split at the one comma outside parentheses; null otherwise.
  function splitPair(text) {
    let depth = 0;
    const cuts = [];
    for (let i = 0; i < text.length; i += 1) {
      if (text[i] === '(') depth += 1;
      else if (text[i] === ')') depth -= 1;
      else if (text[i] === ',' && depth === 0) cuts.push(i);
      if (depth < 0) return null;
    }
    return cuts.length === 1 && depth === 0 ? [text.slice(0, cuts[0]).trim(), text.slice(cuts[0] + 1).trim()] : null;
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
   *   y = a*sin(b*x)        or f(x) = …, g(x) = …: one to four functions, compared on the same axes;
   *                         g(x) = f(x) + 1 or f'(2x) uses another function of the block
   *   a = 1 in [-3, 3]      a parameter, its value and slider range
   *   x in [-2*pi, 2*pi]    optional horizontal window (default [-10, 10])
   *   y in [-4, 4]          optional vertical window (default: fitted to the curve)
   *   f'(x)                 draw the derivative of f, computed from its formula
   *   tangent f at p        the tangent to f at x = p (a parameter or a number inside the window)
   *   area f from a to b    the area under f between two bounds (parameters or numbers)
   *   c(t) = (cos(t), sin(t))  a parametric curve beside the functions (they count together, four at most);
   *                         t in [0, 2*pi] is its parameter's range (the default)
   * or a surface block, with nothing else but parameters and windows:
   *   z = x^2 - y^2         or f(x, y) = …: one or two surfaces
   *   x in [-5, 5]          y in [-5, 5]: the ground window (default [-5, 5] each)
   *   z in [-10, 10]        optional height window (default: fitted to the surface)
   */
  function parsePlot(body) {
    const text = String(body ?? '');
    if (text.length > LIMITS.body) return failure('too_long', 'The math block is too long');
    const lines = text.split('\n').map(line => line.trim().replace(/^`+|`+$/g, '').replace(/^[-*•]\s+/, '').replace(/[.;]\s*$/, '').trim())
      .filter(line => line && !/^```/.test(line));
    const windows = {};
    const parameters = [], sources = [], derivativeLines = [], tangentLines = [], areaLines = [], curveLines = [], surfaceLines = [];
    const taken = name => sources.some(row => row.name === name) || curveLines.some(row => row.name === name) || surfaceLines.some(row => row.name === name);
    const tooMany = () => (curveLines.length ? failure('functions', `At most ${LIMITS.functions} functions and curves per block`)
      : failure('functions', `At most ${LIMITS.functions} functions per block`));
    for (const line of lines) {
      let match;
      if ((match = /^([xyzt])\s*(?:in\b|∈)\s*(.+)$/i.exec(line))) {
        const axis = match[1].toLowerCase();
        const window = range(match[2], `${axis} window`);
        if (!window.ok) return window;
        const width = window.value[1] - window.value[0];
        if (width < 1e-6) return failure('range', 'The window is too narrow');
        windows[axis] = window.value;
      } else if ((match = CURVE_LINE.exec(normalize(line)))) {
        const name = match[1].toLowerCase();
        if (['x', 'y', 't', 'e'].includes(name)) return failure('reserved', `"${name}" cannot name a curve; use c(t), d(t)…`);
        if (taken(name)) return failure('duplicate', `The name ${name} is used twice`);
        const pair = splitPair(match[2]);
        if (!pair) return failure('curve', `Write the curve as ${name}(t) = (x(t), y(t)): two formulas in t, separated by a comma, between parentheses`);
        curveLines.push({ name, x: pair[0], y: pair[1] });
        if (sources.length + curveLines.length > LIMITS.functions) return tooMany();
      } else if ((match = DERIVATIVE_LINE.exec(normalize(line)))) {
        const name = match[1].toLowerCase();
        if (match[2]) return failure('derivative', `Write ${derivativeLabel(name)} alone: Core computes the derivative from ${label(name)}`);
        derivativeLines.push(name);
      } else if ((match = TANGENT_LINE.exec(line))) {
        tangentLines.push({ of: match[1]?.toLowerCase() || null, at: match[2] });
        if (tangentLines.length > LIMITS.tangents) return failure('tangents', `At most ${LIMITS.tangents} tangents per block`);
      } else if ((match = AREA_LINE.exec(line))) {
        areaLines.push({ of: match[1]?.toLowerCase() || null, from: match[2], to: match[3] });
        if (areaLines.length > LIMITS.areas) return failure('areas', `At most ${LIMITS.areas} areas per block`);
      } else if ((match = FUNCTION_LINE.exec(line))) {
        const name = (match[1] || match[2]).toLowerCase();
        if (['x', 't', 'e'].includes(name)) return failure('reserved', `"${name}" cannot name a function; use f(x), g(x)…`);
        if (sources.some(row => row.name === name)) return failure('duplicate', `Function ${name} is declared twice`);
        if (taken(name)) return failure('duplicate', `The name ${name} is used twice`);
        sources.push({ name, source: match[3] });
        if (sources.length + curveLines.length > LIMITS.functions) return tooMany();
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
      } else if ((match = SURFACE_LINE.exec(line))) {
        const name = (match[1] || match[2]).toLowerCase();
        if (['x', 'y', 't', 'e'].includes(name)) return failure('reserved', `"${name}" cannot name a surface; use z = … or f(x, y) = …`);
        if (taken(name)) return failure('duplicate', `The name ${name} is used twice`);
        surfaceLines.push({ name, source: match[3] });
        if (surfaceLines.length > LIMITS.surfaces) return failure('surfaces', `At most ${LIMITS.surfaces} surfaces per block`);
      } else if ((match = /^([a-z])\s*=/i.exec(line))) {
        return failure('range', `Parameter ${match[1].toLowerCase()} needs a slider range, for example: ${match[1].toLowerCase()} = 1 in [-5, 5]`);
      } else return failure('line', `Unrecognised line "${line.slice(0, 60)}". Use y = …, a = 1 in [-5, 5], x in [-10, 10]`);
    }
    if (surfaceLines.length) return surfacePlot(surfaceLines, parameters, windows,
      sources.length || curveLines.length || derivativeLines.length || tangentLines.length || areaLines.length);
    if (windows.z) return failure('line', 'A "z in […]" window goes with a surface z = f(x, y)');
    if (windows.t && !curveLines.length) return failure('line', 'A "t in […]" range goes with a curve c(t) = (x(t), y(t))');
    if (!sources.length && !curveLines.length) return failure('no_function', 'Write the function as y = …');
    const clash = [...sources, ...curveLines].find(row => parameters.some(parameter => parameter.name === row.name));
    if (clash) return failure('duplicate', `"${clash.name}" names both a function and a parameter`);
    const names = ['x', ...parameters.map(row => row.name)];
    const read = sources.length ? parseFunctions(sources, names) : { ok: true, functions: [] };
    if (!read.ok) {
      if (read.error.code === 'unknown_name' && read.error.message.startsWith('Unknown name "y"') && sources.some(row => row.name === 'y')) {
        return failure('unknown_name', 'To use a function in another one, name it f(x), g(x)…; y cannot be called');
      }
      return sources.length > 1 ? failure(read.error.code, `${label(read.name)}: ${read.error.message}`) : failure(read.error.code, read.error.message);
    }
    const functions = read.functions.map(row => ({ name: row.name, label: label(row.name), expression: format(row.tree) }));
    const trees = read.functions.map(row => row.expanded);
    // Curves: both coordinates in t and the parameters, and they may use the block's functions.
    const curveNames = ['t', ...parameters.map(row => row.name)], callable = sources.filter(row => row.name !== 'y').map(row => row.name);
    const curves = [], curveTrees = [];
    for (const row of curveLines) {
      const pair = [];
      for (const [axis, source] of [['x', row.x], ['y', row.y]]) {
        const parsed = parseExpression(source, curveNames, callable);
        if (!parsed.ok) {
          const message = parsed.error.code === 'unknown_name' && /^Unknown name "x"/.test(parsed.error.message)
            ? 'A curve is written in t: c(t) = (cos(t), sin(t))' : parsed.error.message;
          return failure(parsed.error.code, `${row.name}(t), ${axis}: ${message}`);
        }
        const expanded = expandCalls(parsed.tree, read.functions);
        if (!expanded.ok) return failure(expanded.error.code, `${row.name}(t): ${expanded.error.message}`);
        pair.push({ tree: parsed.tree, expanded: expanded.tree });
      }
      curves.push({ name: row.name, label: `${row.name}(t)`, x: format(pair[0].tree), y: format(pair[1].tree) });
      curveTrees.push({ x: pair[0].expanded, y: pair[1].expanded });
    }
    // With functions, x keeps its default window; curves alone are framed around themselves.
    const xWindow = windows.x || null, yWindow = windows.y || null;
    const x = xWindow || (sources.length ? DEFAULT_X.slice() : null);

    // Derivatives, tangents and areas name a function of the block; their points lie in the window.
    const which = (name, what) => {
      if (name && curveLines.some(row => row.name === name)) return failure('line', `${what}: works on functions of x, not on the curve ${name}(t)`);
      if (name) return sources.some(row => row.name === name) ? { ok: true, name } : failure('unknown_name', `${what}: no function named ${name} in this block`);
      return sources.length === 1 ? { ok: true, name: sources[0].name } : failure('line', `${what}: name the function, for example: ${what.toLowerCase()} f …`);
    };
    const point = (source, what) => {
      const name = String(source).trim().toLowerCase();
      const parameter = /^[a-z]$/.test(name) ? parameters.find(row => row.name === name) : null;
      const value = parameter ? { ok: true, value: name } : constant(source, what);
      if (!value.ok) return value;
      const [low, high] = parameter ? [parameter.min, parameter.max] : [value.value, value.value];
      if (low < x[0] || high > x[1]) {
        return failure('range', parameter ? `${what}: ${name} must stay inside the x window [${formatNumber(x[0])}, ${formatNumber(x[1])}]; give it a range inside it`
          : `${what} must lie inside the x window [${formatNumber(x[0])}, ${formatNumber(x[1])}]`);
      }
      return value;
    };
    const derivatives = [];
    for (const name of derivativeLines) {
      const target = which(name, 'Derivative');
      if (!target.ok) return target;
      if (derivatives.includes(target.name)) return failure('duplicate', `The derivative of ${label(target.name)} is asked twice`);
      derivatives.push(target.name);
    }
    const tangents = [];
    for (const row of tangentLines) {
      const target = which(row.of, 'Tangent');
      if (!target.ok) return target;
      const at = point(row.at, 'Tangent point');
      if (!at.ok) return at;
      if (tangents.some(other => other.of === target.name && other.at === at.value)) return failure('duplicate', 'The same tangent is asked twice');
      tangents.push({ of: target.name, at: at.value });
    }
    const areas = [];
    for (const row of areaLines) {
      const target = which(row.of, 'Area');
      if (!target.ok) return target;
      const from = point(row.from, 'Area start'), to = point(row.to, 'Area end');
      if (!from.ok) return from;
      if (!to.ok) return to;
      areas.push({ of: target.name, from: from.value, to: to.value });
    }
    const slopes = {};
    for (const name of new Set([...derivatives, ...tangents.map(row => row.of)])) {
      const tree = derive(trees[functions.findIndex(fn => fn.name === name)]);
      if (weight(tree) > LIMITS.derivative) return failure('too_complex', `The derivative of ${label(name)} is too large to draw`);
      slopes[name] = tree;
    }
    const plot = { schema: SCHEMA, kind: 'functions', variable: 'x', functions, parameters, ...(x ? { x } : {}), ...(yWindow ? { y: yWindow } : {}),
      ...(derivatives.length ? { derivatives } : {}), ...(tangents.length ? { tangents } : {}), ...(areas.length ? { areas } : {}),
      ...(curves.length ? { curves, t: windows.t || DEFAULT_T.slice() } : {}) };
    return { ok: true, plot, trees, slopes, curveTrees, references: read.functions.some(row => usesFunctions(row.tree)), text: plotText(plot) };
  }

  // A surface block: surfaces z = f(x, y) over the ground window, and parameters; nothing else.
  function surfacePlot(rows, parameters, windows, mixed) {
    if (mixed) return failure('surface', 'A surface block holds only surfaces z = f(x, y), parameters and the x, y, z windows; draw curves in another block');
    if (windows.t) return failure('line', 'A "t in […]" range goes with a curve c(t) = (x(t), y(t))');
    const clash = rows.find(row => parameters.some(parameter => parameter.name === row.name));
    if (clash) return failure('duplicate', `"${clash.name}" names both a surface and a parameter`);
    if (parameters.some(row => row.name === 'z')) return failure('reserved', '"z" is the height in a surface block and cannot be a parameter');
    const names = ['x', 'y', ...parameters.map(row => row.name)];
    const surfaces = [], trees = [];
    for (const row of rows) {
      const parsed = parseExpression(row.source, names);
      if (!parsed.ok) return failure(parsed.error.code, rows.length > 1 ? `${surfaceLabel(row.name)}: ${parsed.error.message}` : parsed.error.message);
      surfaces.push({ name: row.name, label: surfaceLabel(row.name), expression: format(parsed.tree) });
      trees.push(parsed.tree);
    }
    const plot = { schema: SCHEMA, kind: 'surfaces', surfaces, parameters, x: (windows.x || DEFAULT_SURFACE).slice(), y: (windows.y || DEFAULT_SURFACE).slice(),
      ...(windows.z ? { z: windows.z } : {}) };
    return { ok: true, plot, trees, slopes: {}, curveTrees: [], references: false, text: plotText(plot) };
  }

  const label = name => (name === 'y' ? 'y' : `${name}(x)`);
  const surfaceLabel = name => (name === 'z' ? 'z' : `${name}(x, y)`);
  const derivativeLabel = name => (name === 'y' ? "y'" : `${name}'(x)`);
  const pointText = value => (typeof value === 'string' ? value : formatNumber(value));

  /** The canonical body for a plot, with `values` replacing the parameters' current values. */
  function plotText(plot, values = {}) {
    const window = (axis, value) => `${axis} in [${formatNumber(value[0])}, ${formatNumber(value[1])}]`;
    const lines = plot.kind === 'surfaces' ? plot.surfaces.map(row => `${row.label} = ${row.expression}`)
      : [...plot.functions.map(fn => `${fn.label} = ${fn.expression}`), ...(plot.curves || []).map(row => `${row.label} = (${row.x}, ${row.y})`)];
    for (const name of plot.derivatives || []) lines.push(derivativeLabel(name));
    for (const row of plot.tangents || []) lines.push(`tangent ${row.of} at ${pointText(row.at)}`);
    for (const row of plot.areas || []) lines.push(`area ${row.of} from ${pointText(row.from)} to ${pointText(row.to)}`);
    for (const row of plot.parameters) {
      const value = Number.isFinite(values[row.name]) ? values[row.name] : row.value;
      lines.push(`${row.name} = ${formatNumber(value)} in [${formatNumber(row.min)}, ${formatNumber(row.max)}]`);
    }
    if (plot.t) lines.push(window('t', plot.t));
    if (plot.x) lines.push(window('x', plot.x));
    if (plot.y) lines.push(window('y', plot.y));
    if (plot.z) lines.push(window('z', plot.z));
    return lines.join('\n');
  }

  function scopeOf(plot, values = {}) {
    const scope = {};
    for (const row of plot.parameters) scope[row.name] = Number.isFinite(values[row.name]) ? values[row.name] : row.value;
    return scope;
  }

  /** Points computed from the formula: [x, y] pairs, y null where undefined or off the chart. */
  function sample(tree, plot, values = {}, count = LIMITS.samples) {
    const scope = scopeOf(plot, values);
    const [x0, x1] = plot.x, points = [];
    for (let i = 0; i <= count; i += 1) {
      const x = x0 + (x1 - x0) * i / count;
      scope.x = x;
      const y = evaluate(tree, scope);
      points.push([x, Number.isFinite(y) && Math.abs(y) < 1e12 ? y : null]);
    }
    return points;
  }

  /** Every curve the picture draws, in order: the functions, then the derivatives asked for. */
  function curves(parsed) {
    return [...parsed.trees, ...(parsed.plot.derivatives || []).map(name => parsed.slopes[name])];
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

  /**
   * A window around every value (parametric coordinates, surface heights), so a narrow peak is
   * never cut off; only when a few values run far away (an asymptote) does it keep the middle
   * 96% instead. A little room is added on both sides.
   */
  function fitRange(values) {
    const sorted = values.filter(value => value !== null && Number.isFinite(value)).sort((a, b) => a - b);
    if (!sorted.length) return [-10, 10];
    let low = sorted[0], high = sorted[sorted.length - 1];
    if (sorted.length >= 20) {
      const at = q => sorted[Math.round(q * (sorted.length - 1))];
      const middle = at(0.98) - at(0.02);
      if (middle > 1e-9 && high - low > middle * 10) { low = at(0.02); high = at(0.98); }
    }
    if (high - low < 1e-9) { low -= 1; high += 1; }
    const pad = (high - low) * 0.08;
    return [low - pad, high + pad];
  }

  /** Points of a parametric curve over its t range: [x, y], or null where undefined. */
  function sampleCurve(trees, plot, values = {}, count = LIMITS.samples) {
    const scope = scopeOf(plot, values), [t0, t1] = plot.t, points = [];
    for (let i = 0; i <= count; i += 1) {
      scope.t = t0 + (t1 - t0) * i / count;
      const x = evaluate(trees.x, scope), y = evaluate(trees.y, scope);
      points.push(Number.isFinite(x) && Number.isFinite(y) && Math.abs(x) < 1e12 && Math.abs(y) < 1e12 ? [x, y] : null);
    }
    return points;
  }

  /** Heights of a surface on a grid over the x, y window: rows[j][i] at (xs[i], ys[j]), null where undefined. */
  function sampleSurface(tree, plot, values = {}, count = LIMITS.grid) {
    const scope = scopeOf(plot, values), xs = [], ys = [], rows = [];
    for (let i = 0; i <= count; i += 1) {
      xs.push(plot.x[0] + (plot.x[1] - plot.x[0]) * i / count);
      ys.push(plot.y[0] + (plot.y[1] - plot.y[0]) * i / count);
    }
    for (const y of ys) {
      rows.push(xs.map(x => {
        const z = evaluate(tree, { ...scope, x, y });
        return Number.isFinite(z) && Math.abs(z) < 1e12 ? z : null;
      }));
    }
    return { xs, ys, rows };
  }

  /**
   * The windows drawn with the current values: declared ones as written, the others fitted.
   * Functions: x declared or default, y fitted to every curve (fitY); curves alone: x and y
   * fitted around them (fitRange). Surfaces: x and y as declared, z fitted to the heights.
   */
  function windowsOf(parsed, values = {}) {
    const { plot } = parsed;
    if (plot.kind === 'surfaces') {
      const z = plot.z ? plot.z.slice() : fitRange(parsed.trees.flatMap(tree => sampleSurface(tree, plot, values).rows.flat()));
      return { x: plot.x.slice(), y: plot.y.slice(), z };
    }
    const curvePoints = (parsed.curveTrees || []).flatMap(trees => sampleCurve(trees, plot, values)).filter(Boolean);
    if (!plot.functions.length) {
      return { x: plot.x ? plot.x.slice() : fitRange(curvePoints.map(point => point[0])),
        y: plot.y ? plot.y.slice() : fitRange(curvePoints.map(point => point[1])) };
    }
    const inside = curvePoints.filter(([px]) => px >= plot.x[0] && px <= plot.x[1]);
    return { x: plot.x.slice(), y: fitY([...curves(parsed).flatMap(tree => sample(tree, plot, values)), ...inside], plot) };
  }

  const pointValue = (value, scope) => (typeof value === 'string' ? scope[value] : value);

  /** The tangent `row` with the current values: its point, height and slope, or null slope/height where undefined. */
  function tangentAt(parsed, row, values = {}) {
    const scope = scopeOf(parsed.plot, values), x = pointValue(row.at, scope);
    const index = parsed.plot.functions.findIndex(fn => fn.name === row.of);
    const y = evaluate(parsed.trees[index], { ...scope, x }), slope = evaluate(parsed.slopes[row.of], { ...scope, x });
    const defined = Number.isFinite(y) && Number.isFinite(slope) && Math.abs(y) < 1e12 && Math.abs(slope) < 1e12;
    return { of: row.of, x, y: defined ? y : null, slope: defined ? slope : null };
  }

  /**
   * The signed area under f between two x values (Simpson's rule on the formula; negative
   * where f is below the axis, and when `to` is left of `from`). null when f is undefined
   * anywhere in between, so an improper integral is never shown as a number.
   */
  function integrate(tree, scope, from, to, steps = LIMITS.integral) {
    if (from === to) return 0;
    const h = (to - from) / steps;
    let sum = 0;
    for (let i = 0; i <= steps; i += 1) {
      const y = evaluate(tree, { ...scope, x: from + h * i });
      if (!Number.isFinite(y)) return null;
      sum += y * (i === 0 || i === steps ? 1 : i % 2 ? 4 : 2);
    }
    const value = sum * h / 3;
    return Number.isFinite(value) && Math.abs(value) < 1e12 ? value : null;
  }

  /** The area `row` with the current values: its bounds and value (null where undefined). */
  function areaOf(parsed, row, values = {}) {
    const scope = scopeOf(parsed.plot, values), from = pointValue(row.from, scope), to = pointValue(row.to, scope);
    const index = parsed.plot.functions.findIndex(fn => fn.name === row.of);
    return { of: row.of, from, to, value: integrate(parsed.trees[index], scope, from, to) };
  }

  /** What the reader of a plot is told: the formula, values, the window drawn and a few points, all computed here. */
  function describe(parsed, values = {}, count = 8) {
    const { plot, trees } = parsed;
    const parameters = plot.parameters.map(row => ({ ...row, value: Number.isFinite(values[row.name]) ? values[row.name] : row.value }));
    const current = Object.fromEntries(parameters.map(row => [row.name, row.value]));
    // Floating-point residue reads as 0: sin(pi) = 1.2e-16, or cos(t) a quarter of a t range written to ten digits (1e-10).
    const round = value => (value === null ? null : Math.abs(value) < 1e-9 ? 0 : Number(formatNumber(value)));
    const drawn = windowsOf(parsed, current);
    if (plot.kind === 'surfaces') {
      // A coarse grid of heights: enough to say where it rises and falls, never a table to read out.
      const grid = tree => {
        const { xs, ys, rows } = sampleSurface(tree, plot, current, 4);
        return rows.flatMap((row, j) => row.map((z, i) => [round(xs[i]), round(ys[j]), round(z)]));
      };
      return { schema: SCHEMA, kind: 'surfaces', surfaces: plot.surfaces.map((row, index) => ({ ...row, points: grid(trees[index]) })),
        parameters, x: drawn.x.map(round), y: drawn.y.map(round), z: drawn.z.map(round) };
    }
    const y = drawn.y.map(round);
    const points = tree => sample(tree, plot, current, count).map(([px, py]) => [round(px), round(py)]);
    const curvePoints = trees => {
      const scope = scopeOf(plot, current), [t0, t1] = plot.t;
      return Array.from({ length: count + 1 }, (_, i) => {
        const t = t0 + (t1 - t0) * i / count, at = { ...scope, t };
        const px = evaluate(trees.x, at), py = evaluate(trees.y, at), defined = Number.isFinite(px) && Number.isFinite(py);
        return [round(t), defined ? round(px) : null, defined ? round(py) : null];
      });
    };
    return { schema: SCHEMA, functions: plot.functions.map((fn, index) => ({ ...fn, points: points(trees[index]) })),
      ...(plot.curves ? { curves: plot.curves.map((row, index) => ({ ...row, points: curvePoints(parsed.curveTrees[index]) })), t: plot.t.map(round) } : {}),
      ...(plot.derivatives ? { derivatives: plot.derivatives.map(name => ({ of: name, label: derivativeLabel(name),
        expression: format(parsed.slopes[name]), points: points(parsed.slopes[name]) })) } : {}),
      ...(plot.tangents ? { tangents: plot.tangents.map(row => {
        const t = tangentAt(parsed, row, current);
        return { of: row.of, x: round(t.x), y: round(t.y), slope: round(t.slope) };
      }) } : {}),
      ...(plot.areas ? { areas: plot.areas.map(row => {
        const a = areaOf(parsed, row, current);
        return { of: row.of, from: round(a.from), to: round(a.to), value: round(a.value) };
      }) } : {}),
      parameters, x: plot.x ? plot.x.slice() : drawn.x.map(round), y };
  }

  /**
   * Slider positions saved for a plot: one finite number per declared parameter, inside its range.
   * Anything else is refused, never clamped, so a saved card never shows values its block did not allow.
   */
  function checkValues(plot, values) {
    const refuse = message => ({ ok: false, error: { code: 'values', message } });
    if (!values || typeof values !== 'object' || Array.isArray(values)) return refuse('Values must be an object of parameter names.');
    const names = plot.parameters.map(row => row.name);
    if (!names.length) return refuse('This plot has no sliders.');
    const keys = Object.keys(values);
    if (keys.length !== names.length || keys.some(key => !names.includes(key))) return refuse(`Values must name exactly: ${names.join(', ')}.`);
    for (const row of plot.parameters) {
      const value = values[row.name];
      if (typeof value !== 'number' || !Number.isFinite(value)) return refuse(`${row.name} must be a finite number.`);
      if (value < row.min || value > row.max) return refuse(`${row.name} must stay within [${formatNumber(row.min)}, ${formatNumber(row.max)}].`);
    }
    return { ok: true, values: Object.fromEntries(names.map(name => [name, values[name]])) };
  }

  const api = Object.freeze({ SCHEMA, LIMITS, FUNCTIONS: Object.keys(FUNCTIONS), parseExpression, parseFunctions, expandCalls, evaluate, format,
    formatNumber, derive, parsePlot, plotText, sample, sampleCurve, sampleSurface, curves, fitY, fitRange, windowsOf, tangentAt, integrate,
    areaOf, describe, checkValues, derivativeLabel });
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.AgentXMathExpression = api;
})(typeof window === 'undefined' ? globalThis : window);
