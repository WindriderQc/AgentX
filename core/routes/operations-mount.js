'use strict';
// Keep operations ownership and page composition together; each capability has
// its own bounded router rather than growing the application bootstrap.
function mount(app) {
  app.use('/api/operations', require('./operations'));
  app.use('/api/operations', require('./operations-backup'));
  return require('./operations-jobs').mount(app);
}
module.exports = {mount};
