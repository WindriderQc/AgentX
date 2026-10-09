'use strict';
function mount(app, jsonParser) {
  app.use('/api/planning', jsonParser, require('./planning'));
  require('./finance').mount(app, jsonParser);
  require('./local-images').mount(app);
  require('./image-lab').mount(app);
  require('./operator-skill').mount(app);
}
module.exports = { mount };
