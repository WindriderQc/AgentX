'use strict';

/**
 * Agent tool usage (owner removal standard, 2026-11-06): count each tools/call
 * on the MCP buses by day, bus, tool and caller, and report every advertised
 * tool with its calls, including the ones nobody calls. Counting never blocks
 * or fails the call it describes.
 *
 * Several layers answer on /mcp (Core's bus, the household and GraphysX
 * surfaces), so the middleware sits in front of all of them and reads the
 * final answer. The advertised list is the last tools/list a client received.
 */

const logger = require('../../config/logger');

const DAY_MS = 86_400_000;
const CALLER_PATTERN = /^[A-Za-z][A-Za-z0-9_.:-]{0,63}$/;
const TOOL_PATTERN = /^[A-Za-z][A-Za-z0-9_.-]{0,79}$/;
const UNNAMED = 'unnamed';
const BUSES = ['general', 'memory', 'owner'];

function usageModel() {
  return require('../../models/AgentToolUsage');
}

function catalogModel() {
  return require('../../models/AgentToolCatalog');
}

function dayOf(time) {
  return new Date(Math.floor(time / DAY_MS) * DAY_MS);
}

function callerLabel(value) {
  const text = String(value || '').trim();
  return CALLER_PATTERN.test(text) ? text : UNNAMED;
}

/** Tools known from code, used until a bus has answered a tools/list. */
function codeCatalogs() {
  const general = new Set(require('./mcpSkillBus').TOOLS.map(tool => tool.name));
  try {
    for (const tool of require('../../surfaces/household/secretary-mcp').SECRETARY_TOOLS) general.add(tool.name);
  } catch { /* the household surface is optional */ }
  return {
    general: [...general],
    memory: ['memory_search', 'memory_remember', 'rag_search'],
    owner: require('./mcpOwnerTools').TOOLS.map(tool => tool.name),
  };
}

// Last advertised names per bus, shared by counting and the report.
const observed = new Map();

/** Record the names a bus just advertised; stores them only when they change. */
async function observeCatalog(bus, names, { model = null, now = Date.now } = {}) {
  if (!BUSES.includes(bus) || !Array.isArray(names)) return;
  const list = [...new Set(names.filter(name => typeof name === 'string' && TOOL_PATTERN.test(name)))].sort();
  if (observed.get(bus)?.join('\u0000') === list.join('\u0000')) return;
  observed.set(bus, list);
  if (!model && process.env.NODE_ENV === 'test') return;
  try {
    await (model || catalogModel()).updateOne({ _id: bus }, { $set: { names: list, observedAt: new Date(now()) } }, { upsert: true });
  } catch (error) {
    logger.warn('[AgentToolUsage] catalog not stored', { bus, error: error?.message });
  }
}

function knownNames(bus) {
  return new Set([...(observed.get(bus) || []), ...(codeCatalogs()[bus] || [])]);
}

/** Increment one daily row. Resolves; a storage failure is logged, never thrown. */
async function countToolCall({ bus, tool, caller, isError = false }, {
  model = null, now = Date.now, known = null,
} = {}) {
  if (!model && process.env.NODE_ENV === 'test') return;
  const names = known ? new Set(known[bus] || []) : knownNames(bus);
  if (!BUSES.includes(bus) || !names.has(tool)) return;
  const Usage = model || usageModel();
  const at = now();
  const key = { day: dayOf(at), bus, tool, caller: callerLabel(caller) };
  const update = { $inc: { calls: 1, failures: isError ? 1 : 0 }, $max: { lastAt: new Date(at) } };
  try {
    await Usage.updateOne(key, update, { upsert: true });
  } catch (error) {
    // Two processes creating the same row: the loser increments it.
    if (error?.code === 11000) {
      await Usage.updateOne(key, update).catch(() => {});
      return;
    }
    logger.warn('[AgentToolUsage] call not counted', { bus, tool, error: error?.message });
  }
}

/**
 * Count one JSON-RPC exchange: tools/list refreshes the advertised names,
 * tools/call counts; a JSON-RPC error or an isError result counts as an error.
 */
function countExchange(bus, req, response, options = {}) {
  const body = req?.body;
  if (!body || typeof body !== 'object') return;
  if (body.method === 'tools/list' && Array.isArray(response?.result?.tools)) {
    void observeCatalog(bus, response.result.tools.map(tool => tool?.name), options.catalog);
    return;
  }
  if (body.method !== 'tools/call' || typeof body.params?.name !== 'string') return;
  const isError = Boolean(response?.error) || response?.result?.isError === true;
  void countToolCall({ bus, tool: body.params.name, caller: req.get?.('x-service-caller'), isError }, options);
}

/**
 * Express middleware placed in front of every layer that answers a bus. It
 * reads the final JSON answer; `bus` is fixed, or general/memory from the path.
 */
function usageMiddleware({ bus = null, options = {} } = {}) {
  return (req, res, next) => {
    const body = req.body;
    if (req.method !== 'POST' || !body || Array.isArray(body) || !['tools/call', 'tools/list'].includes(body.method)) return next();
    const path = String(req.path || '/').replace(/\/$/, '').toLowerCase();
    const target = bus || (path === '/memory' ? 'memory' : path === '' ? 'general' : null);
    if (!target) return next();
    const send = res.json.bind(res);
    res.json = payload => {
      try { countExchange(target, req, payload, options); } catch { /* counting never fails a call */ }
      return send(payload);
    };
    return next();
  };
}

async function storedCatalogs(model) {
  try {
    const rows = await (model || catalogModel()).find({}).lean();
    return Object.fromEntries(rows.filter(row => BUSES.includes(row._id)).map(row => [row._id, row.names || []]));
  } catch { return {}; }
}

/**
 * Every advertised tool over the last `days` days, least used first, with
 * calls, errors, last call and callers. `measuredSince` is the first counted
 * day: a tool at zero means "not called since then", not "never".
 */
async function readToolUsage({ days = 30 } = {}, {
  model = null, catalog = null, now = Date.now, known = null,
} = {}) {
  const Usage = model || usageModel();
  const to = new Date(now());
  const from = dayOf(to.getTime() - (Math.max(1, days) - 1) * DAY_MS);
  const [rows, first, stored] = await Promise.all([
    Usage.aggregate([
      { $match: { day: { $gte: from } } },
      {
        $group: {
          _id: { bus: '$bus', tool: '$tool', caller: '$caller' },
          calls: { $sum: '$calls' }, failures: { $sum: '$failures' },
          lastAt: { $max: '$lastAt' }, days: { $addToSet: '$day' },
        }
      },
    ]),
    Usage.findOne({}, { day: 1 }).sort({ day: 1 }).lean(),
    known ? Promise.resolve({}) : storedCatalogs(catalog),
  ]);
  const fallback = known || codeCatalogs();
  const advertised = Object.fromEntries(BUSES.map(bus => [bus, stored[bus] || fallback[bus] || []]));
  const tools = new Map();
  const entry = (bus, tool) => {
    const key = `${bus}\u0000${tool}`;
    if (!tools.has(key)) tools.set(key, { bus, tool, advertised: false, calls: 0, errors: 0, lastAt: null, daysUsed: new Set(), callers: {} });
    return tools.get(key);
  };
  for (const [bus, names] of Object.entries(advertised)) {
    for (const name of names) entry(bus, name).advertised = true;
  }
  for (const row of rows) {
    const item = entry(row._id.bus, row._id.tool);
    item.calls += row.calls || 0;
    item.errors += row.failures || 0;
    item.callers[row._id.caller] = (item.callers[row._id.caller] || 0) + (row.calls || 0);
    if (row.lastAt && (!item.lastAt || row.lastAt > item.lastAt)) item.lastAt = row.lastAt;
    for (const day of row.days || []) item.daysUsed.add(new Date(day).getTime());
  }
  const list = [...tools.values()]
    .map(item => ({ ...item, daysUsed: item.daysUsed.size }))
    .sort((left, right) => left.calls - right.calls || left.bus.localeCompare(right.bus) || left.tool.localeCompare(right.tool));
  return {
    from, to, days: Math.max(1, days),
    measuredSince: first?.day || null,
    catalogSource: Object.fromEntries(BUSES.map(bus => [bus, stored[bus] ? 'observed' : 'code'])),
    unused: list.filter(item => item.advertised && item.calls === 0).map(item => `${item.bus}/${item.tool}`),
    tools: list,
  };
}

module.exports = {
  countToolCall, countExchange, observeCatalog, usageMiddleware, readToolUsage,
  _internal: { dayOf, callerLabel, codeCatalogs, observed },
};
