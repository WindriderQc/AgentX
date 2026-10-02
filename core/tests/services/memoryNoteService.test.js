'use strict';

const MemoryNote = require('../../models/MemoryNote');
const { forSpace, personal, operatePersonal } = require('../../src/services/memoryNoteService');

describe('Core selected-note ownership with real Mongo', () => {
  const owner = personal();
  const family = forSpace({ audience: 'household', scopeId: 'family', packIds: ['kidx_nestor', 'kidx_reader'] });
  beforeAll(async () => {
    await MemoryNote.createCollection();
    await MemoryNote.createIndexes();
  });
  beforeEach(() => MemoryNote.deleteMany({}));

  test('selected notes share the existing voice collection, retain identity on correction and disappear on forgetting', async () => {
    const saved = await owner.remember({ text: 'Synthetic astronomy preference', kind: 'preference' });
    expect(saved).toMatchObject({ authority: 'agentx.core', created: true, changed: true });
    expect(MemoryNote.collection.name).toBe('household_voice_memories');
    expect(await owner.remember({ text: 'Synthetic astronomy preference', kind: 'preference' })).toMatchObject({ id: saved.id, changed: false });
    expect(await owner.remember({ id: saved.id, text: 'Synthetic astronomy correction' })).toMatchObject({ id: saved.id, kind: 'preference', created: false });
    expect((await owner.search('astronomy')).notes).toEqual([expect.objectContaining({ id: saved.id, text: 'Synthetic astronomy correction' })]);
    expect(await owner.forget(saved.id)).toMatchObject({ removed: true });
    expect(await owner.forget(saved.id)).toMatchObject({ removed: false });
    expect((await owner.list()).notes).toEqual([]);
    await expect(owner.remember({ id: saved.id, text: 'Cannot revive a stale edit' })).rejects.toMatchObject({ statusCode: 404 });
  });

  test('family space cannot read, correct or forget personal, differently scoped, or unclassified records', async () => {
    const saved = await owner.remember({ text: 'Synthetic private astronomy note' });
    await MemoryNote.create({ packId: 'kidx_nestor', scopeId: 'family', text: 'Unclassified historical astronomy' });
    await MemoryNote.create({ packId: 'kidx_nestor', scopeId: 'family', text: 'Private-domain astronomy', scope: 'private_domain', sensitivity: 'highly_private' });
    await forSpace({ audience: 'household', scopeId: 'another-family', packIds: ['kidx_nestor'] }).record({ text: 'Another space astronomy' });
    const shared = await family.record({ text: 'Synthetic shared astronomy' });
    expect((await family.search('astronomy')).notes.map(note => note.id)).toEqual([shared.id]);
    await expect(family.remember({ id: saved.id, text: 'Child overwrite', scope: 'owner' })).rejects.toMatchObject({ statusCode: 404 });
    expect(await family.forget(saved.id)).toMatchObject({ removed: false });
    expect((await owner.list()).notes.map(note => note.id)).toEqual([saved.id]);
  });

  test('concurrent identical notes have one identity and one creation receipt', async () => {
    const receipts = await Promise.all(Array.from({ length: 6 }, () => owner.remember({ text: 'Synthetic concurrent note' })));
    expect(new Set(receipts.map(note => note.id)).size).toBe(1);
    expect(receipts.filter(note => note.created)).toHaveLength(1);
    expect(await owner.count()).toBe(1);
  });

  test('native context retains bounded preferences alongside relevant notes', async () => {
    const preference = await owner.remember({ text: 'Synthetic short replies', kind: 'preference' });
    const match = await owner.remember({ text: 'Synthetic astronomy project' });
    const result = await operatePersonal({ action: 'context', query: 'astronomy', limit: 4 });
    expect(result.notes.map(note => note.id)).toEqual([match.id, preference.id]);
  });

  test('vague questions cannot select personal notes through discourse words or an empty recall topic', async () => {
    const old = await owner.remember({ text: 'Synthetic question about a historical camping plan' });
    await owner.remember({ text: 'Synthetic astronomy suggestion' });
    for (const query of ['Une bonne question, une suggestion ?', 'Une idée ?', 'Raconte une histoire', 'Hello please', 'les des une']) {
      expect((await owner.search(query)).notes).toEqual([]);
    }
    expect((await owner.search('Une question sur le camping')).notes.map(note => note.id)).toEqual([old.id]);
    expect((await owner.list()).notes).toHaveLength(2);
    expect((await owner.list({ query: 'question' })).notes.map(note => note.id)).toEqual([old.id]);
  });

  test('misheard voice fragments do not recall archived notes through common French words', async () => {
    await MemoryNote.insertMany(Array.from({ length: 30 }, (_, index) => ({
      packId: 'personal_operator', scopeId: 'personal', scope: 'owner', sensitivity: 'private',
      text: `Synthetic archived bicycle ${index}: pas non avoir dit aura`
    })));
    const astronomy = await owner.remember({ text: 'Synthetic astronomy observatory' });
    for (const query of ['Je ne veux pas, pourquoi ?', 'Il aura dit quoi ?', "Non, j'avais dit quoi ?"]) {
      expect((await owner.search(query, { limit: 25 })).notes).toEqual([]);
    }
    expect((await owner.search('Parlons du projet astronomy')).notes.map(note => note.id)).toEqual([astronomy.id]);
    expect((await owner.list()).total).toBe(31);
  });

  test('a casual one-word topic is insufficient for voice recall while explicit memory search still works', async () => {
    const old = await owner.remember({ text: 'Synthetic archived hockey schedule' });
    expect((await owner.search('Hockey', { minMatchedTerms: 2 })).notes).toEqual([]);
    expect((await owner.search('Hockey')).notes.map(note => note.id)).toEqual([old.id]);
    expect((await owner.search('archived hockey', { minMatchedTerms: 2 })).notes.map(note => note.id)).toEqual([old.id]);
  });

  test('generic discourse words cannot select old notes, while a creative personal topic can', async () => {
    const old = await owner.remember({ text: 'Synthetic archived son prochain quand schedule' });
    await owner.remember({ text: 'Synthetic archived déjà tout planning' });
    await owner.remember({ text: 'Synthetic archived mais pendant travail' });
    const personal = await owner.remember({ text: 'Synthetic Samuel hockey preference' });
    expect((await owner.search('Quand joue son prochain match l’équipe des Comètes ?', { minMatchedTerms: 2 })).notes).toEqual([]);
    expect((await owner.search('Déjà tout prêt, mais pendant la pause le travail avance', { minMatchedTerms: 2 })).notes).toEqual([]);
    expect((await owner.search('Invente une blague sur Samuel et le hockey', { minMatchedTerms: 2 })).notes.map(note => note.id)).toEqual([personal.id]);
    expect((await owner.search('Rappelle-moi son prochain schedule')).notes.map(note => note.id)).toEqual([old.id]);
  });

  test('explicit voice retries are idempotent and share personal UI notes; forgetting survives a delivery retry', async () => {
    const input = { text: 'Synthetic voice decision', source: 'voix-explicit', sourceTraceId: 'synthetic:voice:1' };
    const saved = await owner.record(input);
    expect((await owner.record(input)).id).toBe(saved.id);
    expect((await operatePersonal({ operation: 'list' })).notes.map(note => note.id)).toEqual([saved.id]);
    await operatePersonal({ operation: 'forget', id: saved.id });
    await owner.record(input);
    expect(await owner.count()).toBe(0);
  });

  test('search reaches relevant old notes beyond the first page and excludes expired notes', async () => {
    const old = await owner.record({ text: 'Synthetic astronomy oldest' });
    await MemoryNote.insertMany(Array.from({ length: 110 }, (_, index) => ({
      packId: 'personal_operator', scopeId: 'personal', text: `Unrelated synthetic ${index}`,
      scope: 'owner', sensitivity: 'private', updatedAt: new Date(Date.now() + 1000)
    })));
    await MemoryNote.create({ packId: 'personal_operator', scopeId: 'personal', text: 'Expired astronomy', expiresAt: new Date(0) });
    expect((await owner.list()).truncated).toBe(true);
    expect((await owner.search('astronomy')).notes.map(note => note.id)).toEqual([old.id]);
  });

  test('correction preserves classification and validates expiry, ids, kind and data shape', async () => {
    const row = await MemoryNote.create({ packId: 'personal_operator', scopeId: 'personal',
      scope: 'private_domain', sensitivity: 'highly_private', text: 'Synthetic sensitive note' });
    expect(await owner.remember({ id: String(row._id), text: 'Corrected sensitive note', scope: 'household' }))
      .toMatchObject({ scope: 'private_domain', sensitivity: 'highly_private' });
    for (const input of [{ text: '' }, { text: 'x', kind: 'system' }, { text: 'x', expiresAt: 'yesterday' },
      { text: 'x', expiresAt: new Date(0).toISOString() }, { text: 'x', id: { $ne: null } }]) {
      await expect(owner.remember(input)).rejects.toMatchObject({ statusCode: 400 });
    }
  });

  test('an agent-written note keeps where it came from, never the owner-dictated label (#207)', async () => {
    const fromMail = await operatePersonal({ operation: 'remember', text: 'Synthetic fact read in a mail review', provenance: 'mail-review', source: 'explicit-ui' });
    const fromChat = await operatePersonal({ operation: 'remember', text: 'Synthetic fact said in conversation', provenance: 'invented-origin' });
    const listed = (await operatePersonal({ operation: 'list' })).notes;
    expect(listed.find(note => note.id === fromMail.id).source).toBe('nestor-mail-review');
    expect(listed.find(note => note.id === fromChat.id).source).toBe('nestor-conversation');
  });
});
