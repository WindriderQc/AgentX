'use strict';

/**
 * Agent tool usage (owner removal standard, 2026-11-06): count each tools/call
 * on the MCP buses by day, bus, tool and caller, and report every advertised
 * tool with its calls, including the ones nobody calls. Counting never blocks
 * or fails the call it describes.
 */

const logger = require('../../config/logger');

const DAY_MS = 86_400_000;
const CALLER_PATTERN = /^[A-Za-z][A-Za-z0-9_.:-]{0,63}$/;
const UNNAMED = 'unnamed';

function usageModel() {
  return require('../../models/AgentToolUsage');
}

function dayOf(time) {
  return new Date(Math.floor(time / DAY_MS) * DAY_MS);
}

function callerLabel(value) {
  const text = String(value || '').trim();
  return CALLER_PATTERN.test(text) ? text : UNNAMED;
}

/** Tools each bus advertises, read at call time so tests and new tools agree. */
function catalogs() {
  const general = require('./mcpSkillBus').TOOLS.map(tool => tool.name);
  return {
    general,
    memory: general.filter(name => ['memory_search', 'memory_remember', 'rag_search'].includes(name)),
    owner: require('./mcpOwnerTools').TOOLS.map(tool => tool.name),
  };
}

/** Increment one daily row. Resolves; a storage failure is logged, never thrown. */
async function countToolCall({ bus, tool, caller, isError = false }, {
  model = null, now = Date.now, known = null,
} = {}) {
  if (!model && process.env.NODE_ENV === 'test') return;
  const names = (known || catalogs())[bus];
  if (!names || !names.includes(tool)) return;
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
 * Count one JSON-RPC exchange from a bus route. Only tools/call is counted;
 * a JSON-RPC error or an isError result counts as an error.
 */
function countExchange(bus, req, response, options) {
  const body = req?.body;
  if (!body || body.method !== 'tools/call' || typeof body.params?.name !== 'string') return;
  const isError = Boolean(response?.error) || response?.result?.isError === true;
  void countToolCall({
    bus, tool: body.params.name, caller: req.get?.('x-service-caller'), isError,
  }, options);
}

/**
 * Every advertised tool over the last `days` days, least used first, with
 * calls, errors, last call and callers. `measuredSince` is the first counted
 * day: a tool at zero means "not called since then", not "never".
 */
async function readToolUsage({ days = 30 } = {}, { model = null, now = Date.now, known = null } = {}) {
  const Usage = model || usageModel();
  const to = new Date(now());
  const from = dayOf(to.getTime() - (Math.max(1, days) - 1) * DAY_MS);
  const [rows, first] = await Promise.all([
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
  ]);
  const tools = new Map();
  const entry = (bus, tool) => {
    const key = `${bus}\u0000${tool}`;
    if (!tools.has(key)) tools.set(key, { bus, tool, advertised: false, calls: 0, errors: 0, lastAt: null, daysUsed: new Set(), callers: {} });
    return tools.get(key);
  };
  for (const [bus, names] of Object.entries(known || catalogs())) {
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
    unused: list.filter(item => item.advertised && item.calls === 0).map(item => `${item.bus}/${item.tool}`),
    tools: list,
  };
}

module.exports = { countToolCall, countExchange, readToolUsage, _internal: { dayOf, callerLabel, catalogs } };
