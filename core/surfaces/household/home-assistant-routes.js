'use strict';

const path = require('node:path');
const ejs = require('ejs');
const { configuration, readPlug } = require('../../src/services/homeAssistantPlug');

function registerHomeAssistantRoutes({ app, screenPages, env = process.env, read = readPlug }) {
  const dateOptions = { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit',
    minute: '2-digit', second: '2-digit', timeZoneName: 'short' };
  let date;
  try {
    date = new Intl.DateTimeFormat('fr-CA', { ...dateOptions, timeZone: env.PLANNING_TIME_ZONE || 'UTC' });
  } catch {
    date = new Intl.DateTimeFormat('fr-CA', { ...dateOptions, timeZone: 'UTC' });
  }
  const number = new Intl.NumberFormat('fr-CA', { maximumSignificantDigits: 10 });
  const template = path.join(__dirname, 'pages/home-assistant.ejs');
  app.get('/dad/home-assistant', async (_req, res, next) => {
    if (!screenPages.PAGES['home-assistant-panel']) return res.sendStatus(404);
    res.set('Cache-Control', 'private, no-store');
    try {
      const plug = await read({ config: configuration(env) });
      const links = ['home-assistant', 'garage-camera'].map(id => screenPages.PAGES[id])
        .filter(link => link?.mode === 'link');
      res.type('html').send(await ejs.renderFile(template, { plug, links, number, date }));
    } catch (error) {
      next(error);
    }
  });
}

module.exports = { registerHomeAssistantRoutes };
