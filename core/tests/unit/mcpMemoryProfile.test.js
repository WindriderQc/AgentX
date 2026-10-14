'use strict';

jest.mock('../../config/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));

const { handleMcpMessage } = require('../../src/services/mcpSkillBus');
const rpc = (method, params, deps = {}, profile = 'memory') =>
  handleMcpMessage({ jsonrpc: '2.0', id: 1, method, params }, deps, { profile });

test('memory profile advertises exactly existing notes and document recall', async () => {
  const listed = await rpc('tools/list');
  expect(listed.result.tools.map(tool => tool.name).sort()).toEqual(['memory_remember', 'memory_search', 'rag_search']);
  const initialized = await rpc('initialize');
  expect(initialized.result.instructions).toMatch(/id to correct/);
  expect(initialized.result.instructions).toMatch(/project files or session history/);
});

test('memory profile reuses the canonical note adapter for read and correction', async () => {
  const note = { id: 'a'.repeat(24), text: 'Synthetic durable preference', kind: 'preference' };
  const memoryNotes = { search: jest.fn(async () => ({ notes: [note] })),
    remember: jest.fn(async input => ({ ...note, ...input, created: false, changed: true })) };
  const found = await rpc('tools/call', { name: 'memory_search', arguments: { query: 'preference' } }, { memoryNotes });
  expect(found.result.structuredContent.notes[0].id).toBe(note.id);
  const corrected = await rpc('tools/call', { name: 'memory_remember', arguments: { id: note.id, text: 'Corrected preference' } }, { memoryNotes });
  expect(memoryNotes.remember).toHaveBeenCalledWith({ id: note.id, text: 'Corrected preference', source: 'mcp-agent' });
  expect(corrected.result.structuredContent.changed).toBe(true);
});

test.each(['create_todo', 'write_vault_note', 'check_health', 'benchmark_request_measurement', 'constructor', '__proto__'])(
  'memory profile refuses guessed %s calls even with a client-selected default profile', async name => {
    const healthProvider = jest.fn();
    await expect(rpc('tools/call', { name, arguments: {}, profile: 'default' }, { healthProvider }))
      .rejects.toMatchObject({ code: 'UNKNOWN_TOOL' });
    expect(healthProvider).not.toHaveBeenCalled();
  },
);

test('unknown profiles refuse rather than falling back to the broad bus', async () => {
  const response = await rpc('tools/list', undefined, {}, 'unknown');
  expect(response.error.code).toBe(-32602);
  expect(response.result).toBeUndefined();
});
