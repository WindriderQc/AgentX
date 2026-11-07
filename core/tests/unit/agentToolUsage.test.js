'use strict';

const express = require('express');
const request = require('supertest');

const AgentToolUsage = require('../../models/AgentToolUsage');
const AgentToolCatalog = require('../../models/AgentToolCatalog');
const { countToolCall, countExchange, observeCatalog, usageMiddleware, readToolUsage, _internal: { dayOf, observed } } = require('../../src/services/agentToolUsage');
const { createAgentToolsRouter } = require('../../routes/agent-tools');

const AT = Date.parse('2026-11-06T15:20:00.000Z');
const DAY = 86_400_000;
const model = AgentToolUsage;
const known = { general: ['memory_search', 'check_health', 'iss_passes'], memory: ['memory_search'], owner: ['work_queue', 'web_search'] };

describe('agent tool usage', () => {
  beforeEach(async () => { await AgentToolUsage.deleteMany({}); await AgentToolCatalog.deleteMany({}); observed.clear(); });

  test('calls increment one daily row per bus, tool and caller; unknown tools are ignored', async () => {
    await AgentToolUsage.createIndexes();
    await Promise.all(Array.from({ length: 3 }, () => countToolCall(
      { bus: 'general', tool: 'memory_search', caller: 'claude-code' }, { model, now: () => AT, known })));
    await countToolCall({ bus: 'general', tool: 'memory_search', caller: 'claude-code', isError: true }, { model, now: () => AT, known });
    await countToolCall({ bus: 'general', tool: 'memory_search', caller: 'bad caller!' }, { model, now: () => AT + DAY, known });
    await countToolCall({ bus: 'owner', tool: 'not_a_tool', caller: 'codex' }, { model, now: () => AT, known });
    await countToolCall({ bus: 'nowhere', tool: 'memory_search', caller: 'codex' }, { model, now: () => AT, known });
    const rows = await AgentToolUsage.find({}).sort({ day: 1 }).lean();
    expect(rows.map(({ day, bus, tool, caller, calls, failures }) => ({ day, bus, tool, caller, calls, failures }))).toEqual([
      { day: dayOf(AT), bus: 'general', tool: 'memory_search', caller: 'claude-code', calls: 4, failures: 1 },
      { day: dayOf(AT + DAY), bus: 'general', tool: 'memory_search', caller: 'unnamed', calls: 1, failures: 0 },
    ]);
  });

  test('without an explicit store, unit tests never write; a storage failure never throws', async () => {
    await countToolCall({ bus: 'general', tool: 'check_health', caller: 'codex' });
    expect(await AgentToolUsage.countDocuments({})).toBe(0);
    const failing = { updateOne: jest.fn(async () => { throw new Error('mongo down'); }) };
    await expect(countToolCall({ bus: 'general', tool: 'check_health' }, { model: failing, known })).resolves.toBeUndefined();
  });

  test('countExchange counts tools/call only, with JSON-RPC errors and isError results as errors', () => {
    const store = { updateOne: jest.fn(async () => ({})) };
    const req = (body, caller = 'hermes-nestor') => ({ body, get: name => (name === 'x-service-caller' ? caller : undefined) });
    const call = name => ({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: {} } });
    countExchange('owner', req({ jsonrpc: '2.0', id: 1, method: 'tools/list' }), { result: {} }, { model: store, known });
    countExchange('owner', req(call('work_queue')), { result: { isError: true } }, { model: store, known });
    countExchange('owner', req(call('web_search')), { error: { code: -32602 } }, { model: store, known });
    countExchange('owner', req(call('web_search')), { result: { isError: false } }, { model: store, known });
    const updates = store.updateOne.mock.calls.map(([key, update]) => [key.tool, key.caller, update.$inc.failures]);
    expect(updates).toEqual([['work_queue', 'hermes-nestor', 1], ['web_search', 'hermes-nestor', 1], ['web_search', 'hermes-nestor', 0]]);
  });

  test('the report lists every advertised tool, unused ones first, within the window', async () => {
    const options = { model, now: () => AT, known };
    await countToolCall({ bus: 'general', tool: 'memory_search', caller: 'codex' }, { ...options, now: () => AT - 40 * DAY });
    await countToolCall({ bus: 'general', tool: 'memory_search', caller: 'codex' }, options);
    await countToolCall({ bus: 'general', tool: 'memory_search', caller: 'hermes-nestor' }, { ...options, now: () => AT - DAY });
    await countToolCall({ bus: 'owner', tool: 'work_queue', caller: 'codex', isError: true }, options);
    const report = await readToolUsage({ days: 30 }, options);
    expect(report.measuredSince).toEqual(dayOf(AT - 40 * DAY));
    expect(report.unused).toEqual(['general/check_health', 'general/iss_passes', 'memory/memory_search', 'owner/web_search']);
    const search = report.tools.find(item => item.bus === 'general' && item.tool === 'memory_search');
    expect(search).toMatchObject({ advertised: true, calls: 2, errors: 0, daysUsed: 2, callers: { codex: 1, 'hermes-nestor': 1 } });
    expect(search.lastAt).toEqual(new Date(AT));
    expect(report.tools.find(item => item.tool === 'work_queue')).toMatchObject({ calls: 1, errors: 1 });
    expect(report.tools.at(-1).tool).toBe('memory_search');
  });

  test('GET /api/agent-tools/usage clamps days and returns the report', async () => {
    const read = jest.fn(async ({ days }) => ({ days, tools: [] }));
    const app = express();
    app.use('/api/agent-tools', createAgentToolsRouter({ read }));
    const res = await request(app).get('/api/agent-tools/usage?days=9999').expect(200);
    expect(res.body).toEqual({ ok: true, data: { days: 400, tools: [] } });
    await request(app).get('/api/agent-tools/usage').expect(200);
    expect(read).toHaveBeenLastCalledWith({ days: 30 });
  });

  test('the middleware counts calls answered by a surface layer and by Core, and learns the advertised list', async () => {
    const store = { updateOne: jest.fn(async () => ({})) };
    const catalog = AgentToolCatalog;
    const app = express();
    app.use(express.json());
    app.use('/mcp', usageMiddleware({ options: { model: store, catalog: { model: catalog } } }));
    // A surface answers its own tool and merges its listing, like the household layer.
    app.use('/mcp', (req, res, next) => {
      if (req.body.method === 'tools/list') {
        const send = res.json.bind(res);
        res.json = body => send({ ...body, result: { tools: [...body.result.tools, { name: 'shopping_list' }] } });
        return next();
      }
      if (req.body.params?.name === 'shopping_list') return res.json({ jsonrpc: '2.0', id: req.body.id, result: { isError: false } });
      return next();
    });
    app.post(['/mcp', '/mcp/memory'], (req, res) => res.json(req.body.method === 'tools/list'
      ? { jsonrpc: '2.0', id: req.body.id, result: { tools: [{ name: 'memory_search' }] } }
      : { jsonrpc: '2.0', id: req.body.id, result: { isError: true } }));
    const post = (path, body) => request(app).post(path).set('x-service-caller', 'codex-dev-host').send({ jsonrpc: '2.0', id: 1, ...body }).expect(200);
    await post('/mcp', { method: 'tools/list' });
    await post('/mcp', { method: 'tools/call', params: { name: 'shopping_list', arguments: {} } });
    await post('/mcp/memory', { method: 'tools/call', params: { name: 'memory_search', arguments: {} } });
    await post('/mcp', { method: 'tools/call', params: { name: 'made_up_tool', arguments: {} } });
    await new Promise(resolve => setImmediate(resolve));
    expect((await AgentToolCatalog.findById('general').lean()).names).toEqual(['memory_search', 'shopping_list']);
    expect(store.updateOne.mock.calls.map(([key, update]) => [key.bus, key.tool, key.caller, update.$inc.failures])).toEqual([
      ['general', 'shopping_list', 'codex-dev-host', 0],
      ['memory', 'memory_search', 'codex-dev-host', 1],
    ]);
    const report = await readToolUsage({ days: 30 }, { model: AgentToolUsage, catalog: AgentToolCatalog });
    expect(report.catalogSource.general).toBe('observed');
    expect(report.tools.filter(item => item.bus === 'general').map(item => item.tool).sort()).toEqual(['memory_search', 'shopping_list']);
  });

  test('an unchanged listing is stored once', async () => {
    const catalog = { updateOne: jest.fn(async () => ({})) };
    await observeCatalog('owner', ['b', 'a'], { model: catalog });
    await observeCatalog('owner', ['a', 'b'], { model: catalog });
    await observeCatalog('nowhere', ['a'], { model: catalog });
    expect(catalog.updateOne).toHaveBeenCalledTimes(1);
  });
});
