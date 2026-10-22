'use strict';
function allowScreenFrame(res) {
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  const policy = res.getHeader('Content-Security-Policy');
  if (policy) res.setHeader('Content-Security-Policy', /frame-ancestors [^;]*/.test(String(policy))
    ? String(policy).replace(/frame-ancestors [^;]*/, "frame-ancestors 'self'")
    : String(policy) + "; frame-ancestors 'self'");
  res.locals.showNav = false;
}
module.exports = { allowScreenFrame };
