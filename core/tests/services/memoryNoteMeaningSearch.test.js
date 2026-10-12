'use strict';

const MemoryNote = require('../../models/MemoryNote');
const { forSpace } = require('../../src/services/memoryNoteService');
const { createIndex } = require('../../src/services/memoryNoteIndex');

// A stand-in embedding model: one axis per topic, and an axis of its own for
// a text about none of them, so an off-topic request is far from every note.
const TOPICS = { hockey: ['hockey', 'canadiens', 'canadien', 'joue', 'equipe'], taxes: ['impot', 'impots', 'cotisation', 'revenu'], snow: ['deneigement', 'neige'] };
const fakeEmbed = async (text) => {
  const words = String(text).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().match(/[a-z]+/g) || [];
  const vector = Object.values(TOPICS).map(names => words.filter(word => names.includes(word)).length);
  return vector.some(Boolean) ? [...vector, 0] : [...vector, 1];
};
const settle = () => new Promise(resolve => setTimeout(resolve, 60));

describe('note search by meaning and by words, real Mongo', () => {
  let embed, owner, family;
  beforeAll(async () => { await MemoryNote.createCollection(); await MemoryNote.createIndexes(); });
  beforeEach(async () => {
    await MemoryNote.deleteMany({});
    delete process.env.MEMORY_NOTE_MEANING_MIN_SCORE;
    embed = jest.fn(fakeEmbed);
    const index = createIndex({ embed: (...args) => embed(...args), model: () => 'fake-embed-v1' });
    owner = forSpace({ audience: 'owner', scopeId: 'personal', packIds: ['personal_operator'], index });
    family = forSpace({ audience: 'household', scopeId: 'family', packIds: ['kidx_nestor'], index });
  });
  afterAll(() => { delete process.env.MEMORY_NOTE_MEANING_MIN_SCORE; });

  test('a question worded differently finds the note that words alone miss', async () => {
    await owner.remember({ text: 'Owner follows the Montreal Canadiens (Hockey)' });
    await owner.remember({ text: 'Contrat de déneigement signé pour la résidence' });
    await settle();
    const found = await owner.search('Est-ce que le Canadien joue ce soir ?', { limit: 4, minMatchedTerms: 2 });
    expect(found.notes.map(note => note.text)).toEqual(['Owner follows the Montreal Canadiens (Hockey)']);
    process.env.MEMORY_NOTE_MEANING_MIN_SCORE = '1';
    expect((await owner.search('Est-ce que le Canadien joue ce soir ?', { limit: 4, minMatchedTerms: 2 })).notes).toEqual([]);
  });

  test('an off-topic request recalls nothing, and a vague one asks for no embedding', async () => {
    await owner.remember({ text: 'Avis de cotisation, impôt payé' });
    await settle();
    expect((await owner.search('Quelle est la capitale de la Mongolie ?')).notes).toEqual([]);
    embed.mockClear();
    expect((await owner.search('Bonjour, merci !')).notes).toEqual([]);
    expect(embed).not.toHaveBeenCalled();
  });

  test('notes close in meaning come first, word matches follow, none twice', async () => {
    const words = await owner.remember({ text: 'Le classeur bleu est dans le dossier archive' });
    const meaning = await owner.remember({ text: 'Impôt et cotisation de la dernière année' });
    await settle();
    const found = await owner.search('cotisation impôt archive', { limit: 4 });
    expect(found.notes.map(note => note.id)).toEqual([meaning.id, words.id]);
    expect((await owner.search('cotisation impôt archive', { limit: 1 })).notes.map(note => note.id)).toEqual([meaning.id]);
  });

  test('without an embedding host the search is the word search it was', async () => {
    await owner.remember({ text: 'Owner follows the Montreal Canadiens (Hockey)' });
    await settle();
    embed.mockRejectedValue(new Error('embedding unavailable'));
    expect((await owner.search('Est-ce que le Canadien joue ce soir ?')).notes).toEqual([]);
    expect((await owner.search('hockey')).notes.map(note => note.text)).toEqual(['Owner follows the Montreal Canadiens (Hockey)']);
  });

  test('meaning never crosses from the owner space to the family space, nor back', async () => {
    await owner.remember({ text: 'Private hockey budget of the owner' });
    const shared = await family.record({ text: 'Family hockey night on Saturday' });
    await settle();
    expect((await family.search('Est-ce que le Canadien joue ?')).notes.map(note => note.id)).toEqual([shared.id]);
    expect((await owner.search('Est-ce que le Canadien joue ?')).notes.map(note => note.text)).toEqual(['Private hockey budget of the owner']);
  });

  test('a forgotten note is not recalled by meaning', async () => {
    const gone = await owner.remember({ text: 'Owner follows the Montreal Canadiens (Hockey)' });
    await settle();
    await owner.forget(gone.id);
    expect((await owner.search('Est-ce que le Canadien joue ce soir ?')).notes).toEqual([]);
  });
});
