const { splitIntoChunks } = require('../../src/services/ragStoreUtils');
const { chunkMarkdownNote, parseMarkdownNote } = require('../../src/services/markdownDocument');

// One character beyond the basic plane: two UTF-16 code units.
const EMOJI = '\u{1F600}';

function expectWellFormed(chunks) {
  for (const chunk of chunks) expect(chunk.isWellFormed()).toBe(true);
}

describe('splitIntoChunks keeps surrogate pairs whole', () => {
  test('emoji straddling the chunk end stays whole', () => {
    // Index 499 is the high half and 500 the low half: a 500 cut splits it.
    const text = `${'a'.repeat(499)}${EMOJI}${'b'.repeat(700)}`;
    const chunks = splitIntoChunks(text, 500, 50);
    expectWellFormed(chunks);
    // The cut moves back to 499 and the next chunk overlaps the last 50 'a'.
    expect(chunks[0]).toBe('a'.repeat(499));
    expect(chunks[1].startsWith(`${'a'.repeat(50)}${EMOJI}b`)).toBe(true);
  });

  test('emoji straddling the overlap start stays whole', () => {
    // First chunk ends at 500; the next starts at 500 - 50 = 450, the low half.
    const text = `${'a'.repeat(449)}${EMOJI}${'b'.repeat(800)}`;
    const chunks = splitIntoChunks(text, 500, 50);
    expectWellFormed(chunks);
    // The overlap start moves back to 449 so the next chunk opens on the emoji.
    expect(chunks[0].startsWith(`${'a'.repeat(449)}${EMOJI}b`)).toBe(true);
    expect(chunks[1].startsWith(`${EMOJI}b`)).toBe(true);
  });

  test('emoji-dense text is never cut inside a pair at any size', () => {
    const text = `Bonjour ${EMOJI} tout le monde. `.repeat(200) + EMOJI.repeat(300);
    for (let size = 100; size <= 160; size += 1) {
      const chunks = splitIntoChunks(text, size, 30);
      expectWellFormed(chunks);
      expect(chunks.join('').includes(EMOJI)).toBe(true);
    }
  });

  test('a large overlap still keeps pairs together and advances', () => {
    const chunks = splitIntoChunks(EMOJI.repeat(400), 100, 99);
    expectWellFormed(chunks);
    expect(chunks.length).toBeGreaterThan(1);
  });
});

describe('chunkMarkdownNote keeps surrogate pairs whole', () => {
  // Title "Note" gives the prefix "Note\n\n" (6 characters); 506 leaves 500 for the body.
  const PREFIX = 'Note\n\n';
  const markdownChunks = (body) => chunkMarkdownNote(parseMarkdownNote(`# Note\n${body}`), 506, 50, splitIntoChunks)
    .map((chunk) => chunk.text);

  test('emoji at the body chunk end stays whole', () => {
    const chunks = markdownChunks(`${'a'.repeat(499)}${EMOJI}${'b'.repeat(700)}`);
    expectWellFormed(chunks);
    expect(chunks[0]).toBe(`${PREFIX}${'a'.repeat(499)}`);
    expect(chunks[1].startsWith(`${PREFIX}${'a'.repeat(50)}${EMOJI}b`)).toBe(true);
  });

  test('emoji at the overlap start stays whole', () => {
    const chunks = markdownChunks(`${'a'.repeat(449)}${EMOJI}${'b'.repeat(800)}`);
    expectWellFormed(chunks);
    expect(chunks[0].startsWith(`${PREFIX}${'a'.repeat(449)}${EMOJI}b`)).toBe(true);
    expect(chunks[1].startsWith(`${PREFIX}${EMOJI}b`)).toBe(true);
  });

  test('emoji-dense sections are never cut inside a pair', () => {
    const section = `Liste ${EMOJI}${EMOJI} courses. `.repeat(80);
    const note = parseMarkdownNote(`# Note\n## Une\n${section}\n## Deux\n${section}`);
    for (let size = 200; size <= 240; size += 1) {
      expectWellFormed(chunkMarkdownNote(note, size, 40, splitIntoChunks).map((chunk) => chunk.text));
    }
  });
});
