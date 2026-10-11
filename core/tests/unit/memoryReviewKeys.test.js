const { resolveShortcut } = require('../../public/js/memory-review-keys');

describe('Dreaming Review shortcuts', () => {
  test('decision keys act only on the focused candidate', () => {
    expect(resolveShortcut('a', { count: 3, index: -1 })).toBeNull();
    expect(resolveShortcut('R', { count: 3, index: -1 })).toBeNull();
    expect(resolveShortcut('a', { count: 3, index: 1 })).toEqual({ action: 'approve' });
    expect(resolveShortcut('e', { count: 3, index: 0 })).toEqual({ action: 'edit_approve' });
  });

  test('J and K start at the first candidate and stay within the list', () => {
    expect(resolveShortcut('j', { count: 3, index: -1 })).toEqual({ move: 0 });
    expect(resolveShortcut('k', { count: 3, index: -1 })).toEqual({ move: 0 });
    expect(resolveShortcut('j', { count: 3, index: 2 })).toEqual({ move: 2 });
    expect(resolveShortcut('k', { count: 3, index: 0 })).toEqual({ move: 0 });
    expect(resolveShortcut('j', { count: 3, index: 0 })).toEqual({ move: 1 });
  });

  test('nothing happens without candidates or for other keys', () => {
    expect(resolveShortcut('j', { count: 0, index: -1 })).toBeNull();
    expect(resolveShortcut('x', { count: 3, index: 1 })).toBeNull();
  });
});
