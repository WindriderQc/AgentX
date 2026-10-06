'use strict';

/**
 * The authored fixtures against real interpreters: the calibration reference
 * answers pass their own tests, the calibration responses score what their
 * tier says, and the catalog fixtures accept a right answer and reject a
 * wrong one. Opt-in (BENCHMARK_DRIVER_SMOKE=1) because it runs code.
 */

jest.mock('../../config/logger', () => ({
    info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn()
}));

const { scoreByExecution } = require('../../src/services/scoring/executionScoring');
const { createCodeRunner } = require('../../src/services/scoring/codeRunnerClient');
const catalog = require('../../data/benchmark-prompts.json');
const calibration = require('../../data/judge-calibration-set.json');

const describeLocal = process.env.BENCHMARK_DRIVER_SMOKE === '1' ? describe : describe.skip;
const lines = (...parts) => parts.join('\n');

async function run(response, item) {
    const runner = createCodeRunner({ mode: 'local' });
    const executed = await scoreByExecution(response, { ...item, category: 'coding' }, { runner });
    return executed.execution;
}

describeLocal('authored fixtures, executed locally', () => {
    test('each calibration reference answer passes its own tests', async () => {
        for (const item of calibration.filter((entry) => entry.reference_tests)) {
            const execution = await run(item.expected_answer, item);
            expect({ id: item.id, status: execution.status, correctness: execution.correctness })
                .toEqual({ id: item.id, status: 'passed', correctness: 10 });
        }
    }, 60000);

    test('the calibration responses score what the plan expects: 0.2 / 10 / 10 / 10', async () => {
        const expected = { 'cal-bad-03': 0.2, 'cal-med-02': 10, 'cal-good-02': 10, 'cal-exc-01': 10 };
        for (const item of calibration.filter((entry) => entry.reference_tests)) {
            const execution = await run(item.response, item);
            expect({ id: item.id, correctness: execution.correctness })
                .toEqual({ id: item.id, correctness: expected[item.id] });
        }
    }, 60000);

    test('the catalog fixtures accept a right answer and reject a wrong one', async () => {
        const byName = Object.fromEntries(catalog.map((item) => [item.name, item]));
        const pairs = [
            ['Array Sum Function',
                lines('def sum_numbers(numbers):', '    return sum(numbers)'),
                lines('def sum_numbers(numbers):', '    return numbers[0]')],
            ['Palindrome Check Function',
                lines('def is_palindrome(text):', '    kept = [ch.lower() for ch in text if ch.isalnum()]', '    return kept == kept[::-1]'),
                lines('def is_palindrome(text):', '    kept = [ch.lower() for ch in text if ch.isalpha()]', '    return kept == kept[::-1]')],
            ['Recursive Fibonacci',
                lines('def fib(n):', '    if n < 2:', '        return n', '    return fib(n - 1) + fib(n - 2)'),
                lines('def fib(n):', '    if n < 2:', '        return 1', '    return fib(n - 1) + fib(n - 2)')],
            ['Extract Shared Helper',
                lines('function sumAll(values) { let s = 0; for (const v of values) s += v; return s; }',
                    'function t(x) { return sumAll(x); }',
                    'function u(y) { return sumAll(y); }',
                    'module.exports = { t, u };'),
                lines('function t(x) { return x.length; }', 'function u(y) { return y.length; }', 'module.exports = { t, u };')],
            ['Off-by-One Loop Fix',
                lines('```js', 'function sumArray(arr) {', '  let sum = 0;',
                    '  for (let i = 0; i < arr.length; i++) { sum += arr[i]; }', '  return sum;', '}', '```',
                    'The loop ran to arr.length inclusive, reading an undefined element.'),
                lines('function sumArray(arr) {', '  let sum = 0;',
                    '  for (let i = 0; i <= arr.length; i++) { sum += arr[i]; }', '  return sum;', '}')],
            ['Split Monolithic Function',
                lines('function validateOrders(orders) {',
                    "  if (!orders || !Array.isArray(orders)) throw new Error('invalid');",
                    "  for (const o of orders) { if (!o.id || !o.amount || o.amount < 0) throw new Error('bad order: ' + o.id); }",
                    '}',
                    'function transformOrder(o) {',
                    "  return { orderId: o.id, total: o.amount * 1.08, label: o.amount > 100 ? 'premium' : 'standard', ts: new Date().toISOString() };",
                    '}',
                    'function buildReport(transformed) {',
                    "  let report = 'Order Report\\n';",
                    '  let grandTotal = 0;',
                    "  for (const t of transformed) { report += t.orderId + ': $' + t.total.toFixed(2) + ' [' + t.label + ']\\n'; grandTotal += t.total; }",
                    "  return report + 'Total: $' + grandTotal.toFixed(2);",
                    '}',
                    'function processOrders(orders) {',
                    '  validateOrders(orders);',
                    '  const transformed = orders.map(transformOrder);',
                    '  return { transformed, report: buildReport(transformed) };',
                    '}',
                    'module.exports = { processOrders };'),
                lines('function processOrders(orders) {',
                    "  if (!Array.isArray(orders)) throw new Error('invalid');",
                    "  for (const o of orders) { if (!o.id || o.amount < 0) throw new Error('bad order: ' + o.id); }",
                    "  const transformed = orders.map((o) => ({ orderId: o.id, total: o.amount * 1.08, label: o.amount > 100 ? 'premium' : 'standard', ts: new Date().toISOString() }));",
                    "  const report = ['Order Report', ...transformed.map((t) => t.orderId + ': $' + t.total.toFixed(2) + ' [' + t.label + ']'),",
                    "    'Total: $' + transformed.reduce((sum, t) => sum + t.total, 0).toFixed(2)].join('\\n');",
                    '  return { transformed, report };',
                    '}',
                    'module.exports = { processOrders };')],
            ['Dependency Injection Refactor',
                lines('class OrderService {',
                    '  constructor({ db, httpClient, cache }) { this.db = db; this.httpClient = httpClient; this.cache = cache; }',
                    '  async getOrder(id) {',
                    "    const cached = await this.cache.get('order:' + id);",
                    '    if (cached) return JSON.parse(cached);',
                    "    const order = await this.db.query('SELECT * FROM orders WHERE id = $1', [id]);",
                    "    await this.cache.set('order:' + id, JSON.stringify(order), 'EX', 300);",
                    '    return order;',
                    '  }',
                    '  async enrichOrder(id) {',
                    '    const order = await this.getOrder(id);',
                    "    const shipping = await this.httpClient.get('https://ship.api.com/status/' + order.trackingId);",
                    '    order.shippingStatus = shipping.data.status;',
                    '    return order;',
                    '  }',
                    '}',
                    'module.exports = { OrderService };'),
                lines("const db = require('../db/connection');",
                    'class OrderService {',
                    '  constructor({ httpClient, cache }) { this.httpClient = httpClient; this.cache = cache; }',
                    "  async getOrder(id) { return db.query('SELECT * FROM orders WHERE id = $1', [id]); }",
                    '}',
                    'module.exports = { OrderService };')],
            ['Count Words Function',
                lines('def count_words(text):', '    return len(text.split())'),
                lines('def count_words(text):', "    return len(text.split(' '))")],
            ['Arithmetic Expression Evaluator',
                lines('import re',
                    'def evaluate(expr):',
                    "    tokens = re.findall(r'\\d+\\.\\d+|\\d+|[-+*/()]', expr)",
                    '    pos = 0',
                    '    def peek():',
                    '        return tokens[pos] if pos < len(tokens) else None',
                    '    def take():',
                    '        nonlocal pos',
                    '        pos += 1',
                    '        return tokens[pos - 1]',
                    '    def factor():',
                    "        if peek() == '-':",
                    '            take()',
                    '            return -factor()',
                    "        if peek() == '(':",
                    '            take()',
                    '            value = expression()',
                    '            take()',
                    '            return value',
                    '        return float(take())',
                    '    def term():',
                    '        value = factor()',
                    "        while peek() in ('*', '/'):",
                    "            value = value * factor() if take() == '*' else value / factor()",
                    '        return value',
                    '    def expression():',
                    '        value = term()',
                    "        while peek() in ('+', '-'):",
                    "            value = value + term() if take() == '+' else value - term()",
                    '        return value',
                    '    return expression()'),
                lines('import re',
                    'def evaluate(expr):',
                    "    tokens = re.findall(r'\\d+\\.\\d+|\\d+|[-+*/()]', expr.replace('(', '').replace(')', ''))",
                    '    value = float(tokens[0])',
                    '    for op, num in zip(tokens[1::2], tokens[2::2]):',
                    "        value = {'+': value + float(num), '-': value - float(num), '*': value * float(num), '/': value / float(num)}[op]",
                    '    return value')],
            ['Build Order With Cycle Detection',
                lines('import heapq',
                    'def build_order(tasks):',
                    '    deps = {name: set(d) for name, d in tasks.items()}',
                    '    for d in list(tasks.values()):',
                    '        for name in d:',
                    '            deps.setdefault(name, set())',
                    '    users = {name: [] for name in deps}',
                    '    for name, d in deps.items():',
                    '        for dep in d:',
                    '            users[dep].append(name)',
                    '    waiting = {name: len(d) for name, d in deps.items()}',
                    '    ready = [name for name, n in waiting.items() if n == 0]',
                    '    heapq.heapify(ready)',
                    '    order = []',
                    '    while ready:',
                    '        name = heapq.heappop(ready)',
                    '        order.append(name)',
                    '        for user in users[name]:',
                    '            waiting[user] -= 1',
                    '            if waiting[user] == 0:',
                    '                heapq.heappush(ready, user)',
                    '    return order if len(order) == len(deps) else None'),
                lines('def build_order(tasks):',
                    '    order, seen = [], set()',
                    '    def visit(name):',
                    '        if name in seen:',
                    '            return',
                    '        seen.add(name)',
                    '        for dep in tasks.get(name, []):',
                    '            visit(dep)',
                    '        order.append(name)',
                    '    for name in tasks:',
                    '        visit(name)',
                    '    return order')]
        ];
        for (const [name, right, wrong] of pairs) {
            const good = await run(right, byName[name]);
            expect({ name, status: good.status, correctness: good.correctness })
                .toEqual({ name, status: 'passed', correctness: 10 });
            const bad = await run(wrong, byName[name]);
            expect({ name, status: bad.status, capped: bad.correctness <= 4 })
                .toEqual({ name, status: 'failed', capped: true });
        }
    }, 120000);
});
