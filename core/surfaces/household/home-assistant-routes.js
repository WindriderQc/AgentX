'use strict';

const path = require('node:path');
const ejs = require('ejs');
const { configuration, readPlug, selectPlug } = require('../../src/services/homeAssistantPlug');
const { readHouseLayout } = require('./housex-layout');
const { readHouseEcosystem, ecosystemScene } = require('./housex-ecosystem');

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
  app.get('/dad/home-assistant', async (req, res, next) => {
    if (!screenPages.PAGES['home-assistant-panel']) return res.sendStatus(404);
    res.set('Cache-Control', 'private, no-store');
    try {
      const config = configuration(env);
      const selected = selectPlug(config, req.query.device);
      if (!selected) return res.sendStatus(404);
      const layout = readHouseLayout(env);
      const ecosystem = screenPages.url(screenPages.parse('ecosystem'));
      const ecosystemConfig = layout && ecosystem ? readHouseEcosystem(env) : null;
      const showEcosystem = req.query.layer === 'ecosystem';
      if (req.query.layer !== undefined && (!showEcosystem || !ecosystemConfig)) return res.sendStatus(404);
      const plug = await read({ config: selected });
      const links = ['home-assistant', 'garage-camera'].map(id => screenPages.PAGES[id])
        .filter(link => link?.mode === 'link');
      const devices = [{ id: 'default', label: config.label, href: screenPages.url(screenPages.parse('home-assistant-panel')) },
        ...config.additionalPlugs.map(row => ({ id: row.id, label: row.label,
          href: screenPages.url(screenPages.parse('home-assistant-device-' + row.id)) }))].filter(row => row.href);
      const camera = links.find(link => link.id === 'garage-camera');
      const infrastructure = ecosystemConfig ? ecosystemScene(ecosystemConfig) : null;
      res.type('html').send(await ejs.renderFile(template, { plug, devices, selected: selected.id || 'default',
        links, layout, camera, ecosystem, infrastructure, showEcosystem, number, date }));
    } catch (error) {
      next(error);
    }
  });
}

module.exports = { registerHomeAssistantRoutes };
