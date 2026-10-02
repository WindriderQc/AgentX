const { normalizeEnvelope } = require('../../middleware/responseEnvelope');

describe('responseEnvelope.normalizeEnvelope', () => {
  test('legacy success gains ok=true, keeps status + data', () => {
    const r = normalizeEnvelope({ status: 'success', data: [1, 2] });
    expect(r).toEqual({ status: 'success', data: [1, 2], ok: true });
  });

  test('legacy error gains ok=false and mirrors message -> error', () => {
    const r = normalizeEnvelope({ status: 'error', message: 'bad' });
    expect(r).toEqual({ status: 'error', message: 'bad', ok: false, error: 'bad' });
  });

  test('native ok gains status=success', () => {
    const r = normalizeEnvelope({ ok: true, id: 'x' });
    expect(r).toEqual({ ok: true, id: 'x', status: 'success' });
  });

  test('native error gains status=error and mirrors error -> message', () => {
    const r = normalizeEnvelope({ ok: false, error: 'nope' });
    expect(r).toEqual({ ok: false, error: 'nope', status: 'error', message: 'nope' });
  });

  test('does not clobber pre-existing companion fields', () => {
    const r = normalizeEnvelope({ status: 'error', ok: false, message: 'm', error: 'e' });
    expect(r).toEqual({ status: 'error', ok: false, message: 'm', error: 'e' });
  });

  test('arrays pass through unchanged', () => {
    expect(normalizeEnvelope([1, 2, 3])).toEqual([1, 2, 3]);
  });

  test('non-envelope objects pass through unchanged (no status/ok)', () => {
    expect(normalizeEnvelope({ foo: 'bar' })).toEqual({ foo: 'bar' });
  });

  test('null/undefined pass through', () => {
    expect(normalizeEnvelope(null)).toBeNull();
    expect(normalizeEnvelope(undefined)).toBeUndefined();
  });

  test('payload data is never mutated', () => {
    const payload = { status: 'success', data: { status: 'running', nested: { ok: false } } };
    const r = normalizeEnvelope(payload);
    expect(r.data).toEqual({ status: 'running', nested: { ok: false } });
  });
});
