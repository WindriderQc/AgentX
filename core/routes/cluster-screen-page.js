'use strict';
const { allowScreenFrame } = require('../../shared/screenView');
const screen = require('../../shared/consultationScreen');
module.exports = app => {
  screen.registerAssets(app);
  app.get('/cluster-schedule', (req, res) => {
    if (req.query.view !== 'screen') return res.redirect(302, '/automations?view=calendar');
    allowScreenFrame(res);
    return screen.render(res, 'cluster-schedule');
  });
};
