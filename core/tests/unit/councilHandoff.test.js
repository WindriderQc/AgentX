const { readCouncilHandoff, handoffMessage, MAX_QUESTION_LENGTH } = require('../../public/js/council-handoff');

describe('Council handoff link', () => {
  test('reads a Playground question and leaves the other parameters in the address', () => {
    const handoff = readCouncilHandoff('?question=Should%20we%20ship%3F&source=playground&tab=x');
    expect(handoff).toEqual({
      question: 'Should we ship?', truncated: false, source: 'playground', id: null, present: true, cleanSearch: '?tab=x'
    });
    expect(handoffMessage(handoff)).toContain('handed off from the Playground');
  });

  test('a question without a known source names a link, not Chat', () => {
    const handoff = readCouncilHandoff('?question=Why');
    expect(handoff.source).toBe('link');
    expect(handoff.cleanSearch).toBe('');
    expect(handoffMessage(handoff)).toContain('handed off from a link');
    expect(handoffMessage(handoff)).not.toContain('Chat');
  });

  test('keeps HTML as plain text and cuts an overlong question to the server limit', () => {
    const markup = '<img src=x onerror=alert(1)>';
    expect(readCouncilHandoff(`?question=${encodeURIComponent(markup)}`).question).toBe(markup);
    const long = readCouncilHandoff(`?question=${'a'.repeat(MAX_QUESTION_LENGTH + 10)}`);
    expect(long.question).toHaveLength(MAX_QUESTION_LENGTH);
    expect(long.truncated).toBe(true);
    expect(handoffMessage(long)).toContain(`cut to ${MAX_QUESTION_LENGTH} characters`);
  });

  test('opens the Council a Telegram link names, and ignores a malformed id', () => {
    expect(readCouncilHandoff('?id=65f0c0ffee0000000000abcd')).toMatchObject({ id: '65f0c0ffee0000000000abcd', question: '', source: null, present: true });
    expect(readCouncilHandoff('?id=../../etc')).toMatchObject({ id: null, present: true, cleanSearch: '' });
  });

  test('a plain visit has nothing to apply', () => {
    expect(readCouncilHandoff('')).toEqual({ question: '', truncated: false, source: null, id: null, present: false, cleanSearch: '' });
    expect(handoffMessage(readCouncilHandoff(''))).toBe('');
  });
});
