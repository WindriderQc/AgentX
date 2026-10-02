'use strict';

const MemoryNote = require('../../models/MemoryNote');
const { handleMcpMessage } = require('../../src/services/mcpSkillBus');
const { forSpace } = require('../../src/services/memoryNoteService');

const call = (name, args) => handleMcpMessage({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } })
  .then(response => response.result);

describe('Core MCP owner memory tools with real Mongo', () => {
  beforeAll(async () => {
    await MemoryNote.createCollection();
    await MemoryNote.createIndexes();
  });
  beforeEach(() => MemoryNote.deleteMany({}));

  test('remember stores one owner note with MCP provenance and search finds it', async () => {
    const saved = await call('memory_remember', { text: 'Synthetic owner prefers tea in the morning', kind: 'preference' });
    expect(saved.isError).toBe(false);
    expect(saved.structuredContent).toMatchObject({ created: true, changed: true, kind: 'preference' });

    const again = await call('memory_remember', { text: 'Synthetic owner prefers tea in the morning', kind: 'preference' });
    expect(again.structuredContent).toMatchObject({ id: saved.structuredContent.id, created: false, changed: false });

    const row = await MemoryNote.findById(saved.structuredContent.id).lean();
    expect(row).toMatchObject({ packId: 'personal_operator', scopeId: 'personal', scope: 'owner', sensitivity: 'private', source: 'mcp-agent' });

    const found = await call('memory_search', { query: 'tea morning' });
    expect(found.structuredContent.notes).toEqual([expect.objectContaining({ id: saved.structuredContent.id, kind: 'preference' })]);
  });

  test('a correction keeps the identity of the note', async () => {
    const saved = (await call('memory_remember', { text: 'Synthetic library day is Monday' })).structuredContent;
    const fixed = (await call('memory_remember', { id: saved.id, text: 'Synthetic library day is Tuesday' })).structuredContent;
    expect(fixed).toMatchObject({ id: saved.id, created: false, changed: true });
    expect(await MemoryNote.countDocuments()).toBe(1);
  });

  test('secret-like text is refused and nothing is stored', async () => {
    const result = await call('memory_remember', { text: 'api_key: abcdefghijklmnopqrstuvwxyz123456' });
    expect(result.isError).toBe(true);
    expect(result.structuredContent.error).toBe('SECRET_LIKE_MEMORY_REFUSED');
    expect(await MemoryNote.countDocuments()).toBe(0);
  });

  test('search never reaches family notes and returns nothing for a vague query', async () => {
    await forSpace({ audience: 'household', scopeId: 'family', packIds: ['kidx_nestor'] }).record({ text: 'Synthetic family tea party' });
    expect((await call('memory_search', { query: 'tea party' })).structuredContent.count).toBe(0);
    expect((await call('memory_search', { query: 'bonjour' })).structuredContent.count).toBe(0);
  });

  test('invalid arguments are tool errors', async () => {
    expect((await call('memory_search', {})).structuredContent.error).toBe('INVALID_ARGUMENTS');
    expect((await call('memory_remember', { text: 'x', kind: 'rumour' })).structuredContent.error).toBe('INVALID_ARGUMENTS');
  });
});
