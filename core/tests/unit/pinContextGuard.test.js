'use strict';
const { contextChangeRefusal } = require('../../src/services/pinContextGuard');

describe('pin context guard', () => {
  const pins = [{ model: 'a', contextSize: 32768 }, { model: 'b', contextSize: 0 }];

  it('keeps unchanged sizes, new pins and omitted sizes', () => {
    expect(contextChangeRefusal(pins, [{ model: 'a', contextSize: 32768 }, { model: 'b' }, { model: 'c', contextSize: 4096 }])).toBeNull();
  });

  it('refuses a changed size of an existing pin', () => {
    const refusal = contextChangeRefusal(pins, [{ model: 'a', contextSize: 8192 }]);
    expect(refusal).toMatchObject({ code: 'HOST_PIN_CONTEXT_GUARDED', statusCode: 409 });
    expect(refusal.message).toContain('a');
  });
});
