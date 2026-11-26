'use strict';

// Both spaces match the same query by word and by vector. Only embedding is
// synthetic; the real index still applies its Mongo audience and scope filter.
jest.mock('../../src/services/memoryNoteIndex', () => {
  const actual = jest.requireActual('../../src/services/memoryNoteIndex');
  return { ...actual, createIndex: () => actual.createIndex({ embed: async () => [1, 0], model: () => 'fixture' }) };
});

const request = require('supertest');
const { app } = require('../../src/app');
const MemoryNote = require('../../models/MemoryNote');
const { familyToolset } = require('../../surfaces/household/family-tools');

const base = '/api/consumers/nestor/v1';
const query = 'almanac';
const grant = 'HOUSEHOLD_PERSONAL_FAMILY_MEMORY_READ';
const originalGrant = process.env[grant];
const owner = request(app);
let personal, family;
const mcpCall = args => ({
  jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'personal_memory', arguments: args },
});

beforeAll(async () => {
  const saved = await owner.post(base + '/memory/notes')
    .send({ action: 'remember', text: 'Synthetic almanac with a copper cover.' }).expect(200);
  personal = saved.body.data;
  const shared = await owner.post('/api/voice-personas/memory')
    .send({ packId: 'kidx_nestor', text: 'Synthetic almanac with a silver cover.' }).expect(201);
  family = shared.body.data.memory;
  expect(personal).toMatchObject({ scope: 'owner', scopeId: 'personal' });
  expect(family).toMatchObject({ scope: 'household', scopeId: 'family' });
});

beforeEach(() => { process.env[grant] = 'true'; });
afterAll(() => {
  if (originalGrant === undefined) delete process.env[grant];
  else process.env[grant] = originalGrant;
});

test('the owner can read Family through HTTP and MCP only with the server grant, without copying or changing either note', async () => {
  const action = { action: 'search_family', query };
  delete process.env[grant];
  await owner.post(base + '/memory/notes').send({ ...action, [grant]: true }).expect(403);
  const denied = await owner.post(base + '/mcp').send(mcpCall(action)).expect(200);
  expect(denied.body.result.isError).toBe(true);
  process.env[grant] = 'true';
  const initialCount = await MemoryNote.countDocuments({});
  expect(initialCount).toBe(2);
  const expected = { operation: 'search_family', memorySpace: 'family', total: 1,
    notes: [expect.objectContaining({ id: family.id, text: family.text, scope: 'household' })] };
  const http = await owner.post(base + '/memory/notes')
    .send({ ...action, scopeId: 'personal', packId: 'personal_operator', id: personal.id }).expect(200);
  expect(http.body.data).toMatchObject(expected);
  const mcp = await owner.post(base + '/mcp').send(mcpCall(action)).expect(200);
  expect(mcp.body.result).toMatchObject({ isError: false, structuredContent: expected });
  const own = await owner.post(base + '/memory/notes').send({ action: 'search', query, scopeId: 'family' }).expect(200);
  expect(own.body.data.notes.map(note => note.id)).toEqual([personal.id]);

  const forget = await owner.post(base + '/memory/notes').send({ action: 'forget', id: family.id, scopeId: 'family' }).expect(200);
  expect(forget.body.data.removed).toBe(false);
  await owner.post(base + '/memory/notes').send({ action: 'remember', id: family.id, text: 'Changed fixture.' }).expect(404);
  expect(await MemoryNote.countDocuments({})).toBe(initialCount);
  expect(await MemoryNote.countDocuments({ _id: family.id, status: 'active', text: family.text })).toBe(1);
});

test('a pinned device and the Family conversation reject owner memory even given a real owner note ID', async () => {
  const tablet = request.agent(app);
  await tablet.post('/api/household/family-device/pin').send({ label: 'Synthetic tablet' }).expect(201);
  const forged = { action: 'search_family', query, id: personal.id, audience: 'owner', scopeId: 'personal' };
  const ownerRead = await tablet.post(base + '/memory/notes').send(forged).expect(403);
  expect(ownerRead.body.code).toBe('FAMILY_DEVICE_PINNED');
  const ownerTool = await tablet.post(base + '/mcp').send(mcpCall({ action: 'forget', id: personal.id })).expect(403);
  expect(ownerTool.body.code).toBe('FAMILY_DEVICE_PINNED');

  const tools = familyToolset({ HOUSEHOLD_FAMILY_TOOLS: 'source_read,personal_memory', [grant]: 'true' });
  expect(tools.names).toEqual(['source_read']);
  const attempted = await tools.execute({ function: { name: 'personal_memory', arguments: forged } });
  expect(attempted.receipt.status).toBe('refused');
  expect(JSON.parse(attempted.message.content).error).toBe('UNKNOWN_TOOL');
  expect(await MemoryNote.countDocuments({ _id: personal.id, status: 'active', text: personal.text })).toBe(1);
});
