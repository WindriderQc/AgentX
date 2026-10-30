const fixtures = require('../../../test/fixtures/memory-content-guard.json');
const guard = require('../../src/services/memoryReview/contentGuard');

describe('synthetic memory content guard parity corpus', () => {
  test.each(fixtures.secret)('refuses and redacts $name', ({ text }) => {
    expect(guard.findSecret(text)).not.toBeNull();
    expect(() => guard.assertReviewSafe(text, 'fixture')).toThrow(expect.objectContaining({ code: 'MEMORY_REVIEW_SECRET_REFUSED' }));
    expect(guard.redact(text)).toContain('[REDACTED]');
    expect(guard.findSecret(guard.redact(text))).toBeNull();
  });
  test.each(fixtures.safe)('preserves legitimate prose: %s', text => {
    expect(guard.findSecret(text)).toBeNull();
    expect(() => guard.assertReviewSafe(text, 'fixture')).not.toThrow();
    expect(guard.redact(text)).toBe(text);
  });
  test.each(fixtures.unicodeSafe)('preserves legitimate Unicode: $name', ({ text }) => {
    expect(() => guard.assertReviewSafe(text, 'fixture')).not.toThrow();
  });
  test.each(fixtures.unicodeUnsafe)('refuses unsafe Unicode: $name', ({ text }) => {
    expect(() => guard.assertReviewSafe(text, 'fixture')).toThrow(expect.objectContaining({ code: 'MEMORY_REVIEW_INVISIBLE_REFUSED' }));
  });
});

describe('base memory entry points keep the expanded secret coverage', () => {
  const { assertMemoryText } = require('../../src/services/nestorMemoryService');
  const remember = require('../../src/services/mcpMemoryTools').MEMORY_TOOL_HANDLERS.memory_remember;
  const names = ['gho', 'ghu', 'ghs', 'ghr', 'fine-grained', 'minimum-assignment', 'quoted-json-key', 'punctuated-password'];
  test.each(fixtures.secret.filter(sample => names.includes(sample.name)))('direct and MCP memory refuse $name', async ({ text }) => {
    expect(() => assertMemoryText(text)).toThrow(expect.objectContaining({ code: 'SECRET_LIKE_MEMORY_REFUSED' }));
    const memoryNotes = { remember: jest.fn() };
    await expect(remember({ text }, { memoryNotes })).rejects.toMatchObject({ code: 'SECRET_LIKE_MEMORY_REFUSED' });
    expect(memoryNotes.remember).not.toHaveBeenCalled();
  });
});
