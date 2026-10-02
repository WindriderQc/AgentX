const fs = require('fs/promises');
const os = require('os');
const path = require('path');

const { createVaultInbox } = require('../../src/services/vaultInboxService');
const { handleMcpMessage } = require('../../src/services/mcpSkillBus');

describe('vault inbox', () => {
  let root;
  const clock = () => new Date('2026-09-23T14:05:00.000Z');

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'vault-inbox-'));
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  test('writes an Obsidian note with review frontmatter', async () => {
    const inbox = createVaultInbox({ root, clock });
    const receipt = await inbox.writeNote({
      title: 'Idée: jardin / potager', body: '## Plan\nVoir [[Cour arrière]].', tags: ['#maison', 'idee']
    }, { author: 'nestor' });

    expect(receipt).toEqual({
      ok: true, authority: 'agentx.core', operation: 'write_vault_note',
      file: '2026-09-23 Idée jardin potager.md', title: 'Idée jardin potager',
      created: '2026-09-23T14:05:00.000Z', status: 'inbox'
    });
    expect(await fs.readFile(path.join(root, receipt.file), 'utf8')).toBe([
      '---',
      'title: "Idée jardin potager"',
      'created: 2026-09-23T14:05:00.000Z',
      'author: nestor',
      'status: inbox',
      'tags:',
      '  - "maison"',
      '  - "idee"',
      '---',
      '',
      '## Plan',
      'Voir [[Cour arrière]].',
      ''
    ].join('\n'));
    expect(await fs.readdir(root)).toEqual([receipt.file]);
  });

  test('never overwrites a note and keeps path separators out of file names', async () => {
    const inbox = createVaultInbox({ root, clock });
    await fs.writeFile(path.join(root, '2026-09-23 Liste.md'), 'owner text');
    const first = await inbox.writeNote({ title: 'Liste', body: 'a' }, { author: 'agent' });
    const second = await inbox.writeNote({ title: '../Liste', body: 'b' }, { author: 'agent' });

    expect(first.file).toBe('2026-09-23 Liste (2).md');
    expect(second.file).toBe('2026-09-23 Liste (3).md');
    expect(await fs.readFile(path.join(root, '2026-09-23 Liste.md'), 'utf8')).toBe('owner text');
    expect((await fs.readdir(root)).sort()).toHaveLength(3);
  });

  test('rejects invalid input and a missing server-selected author', async () => {
    const inbox = createVaultInbox({ root, clock });
    await expect(inbox.writeNote({ title: 'x', body: 'y' })).rejects.toMatchObject({ code: 'VAULT_AUTHOR_REQUIRED' });
    await expect(inbox.writeNote({ title: ' / ', body: 'y' }, { author: 'agent' })).rejects.toMatchObject({ code: 'VAULT_NOTE_INVALID' });
    await expect(inbox.writeNote({ title: 'x', body: '  ' }, { author: 'agent' })).rejects.toMatchObject({ code: 'VAULT_NOTE_INVALID' });
    await expect(inbox.writeNote({ title: 'x', body: 'y', tags: ['a b'] }, { author: 'agent' })).rejects.toMatchObject({ code: 'VAULT_NOTE_INVALID' });
    await expect(inbox.writeNote({ title: 'x', body: 'y'.repeat(70000) }, { author: 'agent' })).rejects.toMatchObject({ statusCode: 413 });
    expect(await fs.readdir(root)).toEqual([]);
  });

  test('is disabled without an absolute configured folder and unavailable when it is missing', async () => {
    expect(createVaultInbox({ root: '' }).enabled).toBe(false);
    await expect(createVaultInbox({ root: 'relative/inbox' }).writeNote({ title: 'x', body: 'y' }, { author: 'agent' }))
      .rejects.toMatchObject({ code: 'VAULT_INBOX_DISABLED', statusCode: 503 });
    const missing = createVaultInbox({ root: path.join(root, 'absent') });
    await expect(missing.writeNote({ title: 'x', body: 'y' }, { author: 'agent' }))
      .rejects.toMatchObject({ code: 'VAULT_INBOX_UNAVAILABLE' });
  });

  test('the MCP tool writes as an agent, never as Nestor', async () => {
    const vaultInbox = createVaultInbox({ root, clock });
    const response = await handleMcpMessage({
      jsonrpc: '2.0', id: 9, method: 'tools/call',
      params: { name: 'write_vault_note', arguments: { title: 'Résumé', body: 'Texte' } }
    }, { vaultInbox });
    expect(response.result.isError).not.toBe(true);
    const [file] = await fs.readdir(root);
    expect(await fs.readFile(path.join(root, file), 'utf8')).toContain('author: agent');
  });
});

describe('vault inbox without hard links', () => {
  test('falls back to an exclusive create that still never overwrites', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'vault-inbox-'));
    const link = jest.spyOn(fs, 'link').mockRejectedValue(Object.assign(new Error('no links'), { code: 'EPERM' }));
    try {
      await fs.writeFile(path.join(root, '2026-09-23 Note.md'), 'owner text');
      const inbox = createVaultInbox({ root, clock: () => new Date('2026-09-23T00:00:00Z') });
      const receipt = await inbox.writeNote({ title: 'Note', body: 'agent text' }, { author: 'agent' });
      expect(receipt.file).toBe('2026-09-23 Note (2).md');
      expect(await fs.readFile(path.join(root, '2026-09-23 Note.md'), 'utf8')).toBe('owner text');
      expect((await fs.readdir(root)).filter((name) => name.endsWith('.tmp'))).toEqual([]);
    } finally {
      link.mockRestore();
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});
