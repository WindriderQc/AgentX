import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createCoreBriefClient } from '../core-brief.js';

// Hermes consumes the owner MCP route; OpenClaw uses its existing HTTP client.
// Exercise both real Core routes with the same synthetic source records.
process.env.NODE_ENV = 'test';
const require = createRequire(new URL('../../../../core/package.json', import.meta.url));
const express = require('express');
const request = require('supertest');
const mongoose = require('mongoose');
// Core's imported routing cache may read before a connection exists. Refuse
// immediately instead of retaining Mongoose's ten-second disconnected buffer.
mongoose.set('bufferCommands', false);
const createRoutes = require('./routes/nestor-consumer-v1');
const briefs = require('./src/services/teamBriefService');
const originalBrief = briefs.brief;
const AS_OF = '2026-03-15T12:00:00.000Z';
const PREFIX = '/api/consumers/nestor/v1';
const RECORDS = [1, 2, 3].map(number => ({
  id: `synthetic-mail-${number}`, threadId: `synthetic-thread-${number}`,
  occurredAt: `2026-03-${15 - number}T09:00:00.000Z`,
  subject: `Synthetic subject ${number}`, summary: `Synthetic digest ${number}.`,
  sourceRef: `fixture:mail:${number}`,
}));

function fixture(t, { partial = false, unavailable = false } = {}) {
  const calls = [], transports = [];
  t.mock.method(globalThis, 'fetch', () => assert.fail('No external fetch or model call is allowed'));
  t.mock.method(mongoose.Connection.prototype, 'openUri', () => assert.fail('No database is allowed'));
  t.mock.method(require('./config/logger'), 'error', () => {});
  const sources = {
    emailActions: { recent: async () => {
      if (partial) throw new Error('Synthetic action source unavailable');
      return { actions: [{ threadId: RECORDS[0].threadId, action: 'Synthetic reply needed',
        createdAt: RECORDS[0].occurredAt }] };
    } },
    mailJournal: { search: async ({ limit = 20, offset = 0 }) => {
      const entries = RECORDS.slice(offset, offset + limit);
      const hasMore = offset + entries.length < RECORDS.length;
      return { entries, total: RECORDS.length, truncated: hasMore,
        pagination: { limit, offset, returned: entries.length, hasMore,
          nextOffset: hasMore ? offset + entries.length : null, consistency: 'live' } };
    } },
  };
  t.mock.method(briefs, 'brief', async input => {
    calls.push(structuredClone(input));
    if (unavailable) throw new Error('Synthetic Core failure');
    return originalBrief(input, { sources, now: () => new Date(AS_OF) });
  });
  const app = express();
  app.use(express.json());
  app.use(PREFIX, createRoutes({ runtimeServices: {
    inference: { execute: () => assert.fail('No inference is allowed') },
  } }));
  const transport = async (url, options) => {
    const parsed = new URL(url);
    assert.equal(parsed.origin, 'http://core.invalid');
    assert.ok([PREFIX + '/mcp', PREFIX + '/team-brief'].includes(parsed.pathname));
    assert.equal(options.method, 'POST');
    const body = JSON.parse(options.body);
    transports.push({ path: parsed.pathname, body });
    // Supertest owns a disposable loopback listener; no live Core is contacted.
    const response = await request(app).post(parsed.pathname).send(body);
    return new Response(JSON.stringify(response.body), { status: response.status,
      headers: response.headers });
  };
  const openclaw = createCoreBriefClient({ baseUrl: 'http://core.invalid', fetchImpl: transport });
  const ownerMcp = async input => {
    const response = await transport('http://core.invalid' + PREFIX + '/mcp', {
      method: 'POST', body: JSON.stringify({ jsonrpc: '2.0', id: 'synthetic-brief', method: 'tools/call',
        params: { name: 'team_brief', arguments: input } }),
    });
    assert.equal(response.status, 200);
    const message = await response.json();
    assert.equal(message.id, 'synthetic-brief');
    assert.equal(message.error, undefined);
    return message.result;
  };
  const both = async input => {
    const [mcp, native] = await Promise.all([ownerMcp(input), openclaw(input)]);
    assert.equal(mcp.isError, false);
    assert.deepEqual(mcp.structuredContent, native);
    assert.deepEqual(JSON.parse(mcp.content[0].text), native);
    return native;
  };
  return { both, ownerMcp, openclaw, calls, transports };
}

test('owner MCP and OpenClaw preserve the same complete Secretary brief', async t => {
  const f = fixture(t);
  const input = { member: 'secretary', days: 7, asOf: AS_OF };
  const result = await f.both(input);
  assert.equal(result.authority, 'agentx.core');
  assert.equal(result.kind, 'team_brief');
  assert.equal(result.asOf, AS_OF);
  assert.equal(result.since, '2026-03-08T12:00:00.000Z');
  assert.deepEqual(result.sections.mail.entries, RECORDS);
  assert.equal(result.sections.mail.truncated, false);
  assert.equal(result.sections.flaggedForOwner.actions[0].threadId, RECORDS[0].threadId);
  assert.deepEqual(result.metadata.mail, { source: 'agentx.core.secretary.mail', windowAsOf: AS_OF,
    freshness: { status: 'unknown', sourceUpdatedAt: null } });
  assert.deepEqual(f.calls, [input, input]);
});

test('both transports retain unavailable sections and the same record continuation', async t => {
  const f = fixture(t, { partial: true });
  const input = { member: 'secretary', days: 7, limit: 1, asOf: AS_OF };
  let page = await f.both(input);
  assert.deepEqual(page.sections.flaggedForOwner,
    { unavailable: 'Source unavailable', code: 'SOURCE_UNAVAILABLE' });
  assert.equal(page.sections.mail.total, 3);
  const records = [...page.sections.mail.entries];
  for (const nextOffset of [1, 2]) {
    assert.equal(page.sections.mail.truncated, true);
    assert.equal(page.sections.mail.pagination.hasMore, true);
    assert.equal(page.sections.mail.pagination.nextOffset, nextOffset);
    const continuation = { ...input, section: 'mail', offset: nextOffset, asOf: page.asOf };
    page = await f.both(continuation);
    assert.deepEqual(f.calls.slice(-2), [continuation, continuation]);
    assert.deepEqual(Object.keys(page.sections), ['mail']);
    assert.equal(page.asOf, AS_OF);
    records.push(...page.sections.mail.entries);
  }
  assert.deepEqual(records, RECORDS);
  assert.equal(page.sections.mail.truncated, false);
  assert.equal(page.sections.mail.pagination.hasMore, false);
  assert.equal(page.sections.mail.pagination.nextOffset, null);
  assert.equal(f.calls.length, 6, 'each transport reads once per requested page');
  assert.equal(f.transports.length, 6, 'neither transport retries or fetches an extra page');
});

test('Core failure stays an explicit error in both transports, never an empty brief', async t => {
  const f = fixture(t, { unavailable: true });
  const input = { member: 'secretary', asOf: AS_OF };
  const mcp = await f.ownerMcp(input);
  assert.equal(mcp.isError, true);
  assert.deepEqual(mcp.structuredContent,
    { error: 'OWNER_TOOL_UNAVAILABLE', message: 'The owner capability is unavailable.' });
  assert.deepEqual(JSON.parse(mcp.content[0].text), mcp.structuredContent);
  await assert.rejects(f.openclaw(input), /Core team brief unavailable \(500\)/);
  assert.deepEqual(f.calls, [input, input]);
  assert.equal(f.transports.length, 2, 'a failed read triggers no retry or alternate capability');
});
