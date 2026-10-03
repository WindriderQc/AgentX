'use strict';
function mount(app, jsonParser) {
  app.use('/api/planning', jsonParser, require('./planning'));
  require('./finance').mount(app, jsonParser);
  require('./local-images').mount(app);
}
module.exports = { mount };
