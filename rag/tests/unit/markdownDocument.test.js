const {
  chunkMarkdownNote,
  noteClassification,
  parseMarkdownNote,
  prepareMarkdownIngest
} = require('../../src/services/markdownDocument');
const { splitIntoChunks } = require('../../src/services/ragStoreUtils');

const NOTE = [
  '---',
  'title: Lave-vaisselle',
  'aliases: [Dishwasher]',
  'tags:',
  '  - appareil',
  '  - "cuisine"',
  'warranty_until: 2027-03-01',
  'manual: "[[Manuel lave-vaisselle]]"',
  '---',
  'Modèle synthétique. Voir [[Garantie#Couverture|la garantie]] et ![[photo.jpg]].',
  '%% note privée %%',
  '',
  '## Entretien',
  'Nettoyer le filtre chaque mois. #routine',
  '',
  '### Filtre',
  'Tourner puis tirer.',
  '```',
  '# pas un titre',
  '```',
  '',
  '## Garantie',
  'Appeler le service.'
].join('\r\n');

describe('parseMarkdownNote', () => {
  const note = parseMarkdownNote(NOTE, { fallbackTitle: 'fichier' });

  it('reads frontmatter properties, tags and aliases', () => {
    expect(note.title).toBe('Lave-vaisselle');
    expect(note.properties.warranty_until).toBe('2027-03-01');
    expect(note.aliases).toEqual(['dishwasher']);
    expect(note.tags).toEqual(expect.arrayContaining(['appareil', 'cuisine', 'routine']));
  });

  it('keeps heading breadcrumbs and ignores headings inside code fences', () => {
    expect(note.sections.map((section) => section.headingPath)).toEqual([
      [], ['Entretien'], ['Entretien', 'Filtre'], ['Garantie']
    ]);
    expect(note.sections[2].text).toContain('# pas un titre');
  });

  it('resolves wikilinks to readable text, records targets and drops comments and media embeds', () => {
    expect(note.sections[0].text).toBe('Modèle synthétique. Voir la garantie et .');
    expect(note.links).toEqual(['manuel lave-vaisselle', 'garantie']);
    expect(note.sections.map((section) => section.text).join('\n')).not.toContain('privée');
  });

  it('falls back to the first heading, then the file name, for the title', () => {
    expect(parseMarkdownNote('# Recette\nPâte').title).toBe('Recette');
    expect(parseMarkdownNote('Sans titre', { fallbackTitle: 'routine-matin' }).title).toBe('routine-matin');
  });

  it('treats a note without closing frontmatter as plain text', () => {
    const parsed = parseMarkdownNote('---\nscope: owner\nno end');
    expect(parsed.properties).toEqual({});
    expect(parsed.sections[0].text).toContain('scope: owner');
  });
});

describe('chunkMarkdownNote', () => {
  it('prefixes every chunk with its breadcrumb and puts descriptive properties in the first chunk', () => {
    const chunks = chunkMarkdownNote(parseMarkdownNote(NOTE), 500, 50, splitIntoChunks);
    expect(chunks[0].text).toBe('Lave-vaisselle\n\nwarranty_until: 2027-03-01\nmanual: Manuel lave-vaisselle\n\nModèle synthétique. Voir la garantie et .');
    expect(chunks[0].text).not.toContain('aliases');
    expect(chunks[2]).toMatchObject({ headingPath: 'Lave-vaisselle > Entretien > Filtre' });
    expect(chunks[2].text.startsWith('Lave-vaisselle > Entretien > Filtre\n\nTourner')).toBe(true);
  });

  it('does not repeat a first-level heading that is also the title', () => {
    const chunks = chunkMarkdownNote(parseMarkdownNote('# Recette\n## Pâte\nFarine'), 500, 50, splitIntoChunks);
    expect(chunks.map((chunk) => chunk.headingPath)).toEqual(['Recette > Pâte']);
  });

  it('indexes a properties-only note as one chunk', () => {
    const chunks = chunkMarkdownNote(parseMarkdownNote('---\npurchased: 2024-05-01\n---\n', { fallbackTitle: 'Four' }), 500, 50, splitIntoChunks);
    expect(chunks).toEqual([{ text: 'Four\n\npurchased: 2024-05-01', headingPath: 'Four' }]);
  });
});

describe('noteClassification', () => {
  const household = { scope: 'household', sensitivity: 'normal' };

  it('keeps folder labels when the note has none', () => {
    expect(noteClassification(household, {})).toEqual({ classification: household });
    expect(noteClassification({}, {})).toEqual({ classification: {} });
  });

  it('lets a note narrow its folder labels', () => {
    expect(noteClassification(household, { sensitivity: 'private' }))
      .toEqual({ classification: { scope: 'household', sensitivity: 'private' } });
    expect(noteClassification(household, { scope: 'owner' }))
      .toEqual({ classification: { scope: 'owner', sensitivity: 'normal' } });
    expect(noteClassification({}, { sensitivity: 'highly_private' }))
      .toEqual({ classification: { scope: 'owner', sensitivity: 'highly_private' } });
  });

  it('never lowers the folder sensitivity', () => {
    expect(noteClassification({ scope: 'owner', sensitivity: 'private' }, { sensitivity: 'normal' }))
      .toEqual({ classification: { scope: 'owner', sensitivity: 'private' } });
  });

  it('refuses household labels outside a household folder and unknown labels', () => {
    expect(noteClassification({}, { scope: 'household' })).toEqual({ reason: 'note_classification_widening' });
    expect(noteClassification({ scope: 'owner', sensitivity: 'normal' }, { scope: 'household' }))
      .toEqual({ reason: 'note_classification_widening' });
    expect(noteClassification(household, { sensitivity: 'privé' })).toEqual({ reason: 'invalid_note_classification' });
  });
});

describe('prepareMarkdownIngest', () => {
  it('excludes notes marked rag: false', () => {
    expect(prepareMarkdownIngest('---\nrag: false\n---\nTexte', {})).toEqual({ reason: 'excluded_by_note' });
  });

  it('reports notes with nothing indexable as empty', () => {
    expect(prepareMarkdownIngest('---\ntags: [a]\n---\n%% brouillon %%\n', {})).toEqual({ reason: 'empty extracted text' });
  });

  it('returns the combined labels and the markdown format', () => {
    expect(prepareMarkdownIngest('---\nsensitivity: private\n---\nTexte', { scope: 'household', sensitivity: 'normal' }))
      .toEqual({ classification: { scope: 'household', sensitivity: 'private' }, format: 'markdown' });
  });
});
