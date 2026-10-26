'use strict';
const { allowStudioFrame } = require('../../routes/pipeline-page');
const original = { ...process.env };
afterEach(() => { process.env = { ...original }; });
function response() {
  const headers = { 'Content-Security-Policy': "default-src 'self'; frame-ancestors 'none'; connect-src 'self'", 'X-Frame-Options': 'DENY' };
  return { headers, getHeader: name => headers[name], setHeader: (name, value) => { headers[name] = value; }, removeHeader: name => { delete headers[name]; } };
}
test('only the dedicated Studio view admits the exact configured Studio origin', () => {
  process.env.CORE_PUBLIC_URL = 'https://agentx.example';
  process.env.DSH_STUDIO_PUBLIC_URL = 'https://agentx.example:18791';
  process.env.DSH_STUDIO_ACCESS_SECRET = 'x'.repeat(32);
  const res = response(); allowStudioFrame(res);
  expect(res.headers['Content-Security-Policy']).toBe("default-src 'self'; frame-ancestors 'self' https://agentx.example:18791; connect-src 'self'");
  expect(res.headers['X-Frame-Options']).toBeUndefined();
});
test('an unconfigured Studio keeps same-origin framing and rejects an unrelated host', () => {
  delete process.env.DSH_STUDIO_PUBLIC_URL;
  const res = response(); allowStudioFrame(res);
  expect(res.headers['X-Frame-Options']).toBe('SAMEORIGIN');
  expect(res.headers['Content-Security-Policy']).not.toContain('https:');
  process.env.CORE_PUBLIC_URL = 'https://agentx.example'; process.env.DSH_STUDIO_PUBLIC_URL = 'https://unrelated.example';
  process.env.DSH_STUDIO_ACCESS_SECRET = 'x'.repeat(32);
  expect(() => allowStudioFrame(response())).toThrow(/same hostname/);
});
