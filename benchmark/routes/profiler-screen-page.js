'use strict';
const screen = require('../../shared/consultationScreen');
module.exports = (req, res, next) => {
  if (req.query.view !== 'screen') return next();
  // productPageConfig grants self framing only for the current same-origin
  // catalogue destination. A separately hosted Benchmark keeps its denial.
  if (res.locals.showNav !== false) res.setHeader('X-Frame-Options', 'DENY');
  const prefix = res.locals.publicUrls?.benchmark
    ? new URL(res.locals.publicUrls.benchmark).pathname.replace(/\/$/, '') : '/benchmark';
  return screen.render(res, 'profiler', prefix);
};
