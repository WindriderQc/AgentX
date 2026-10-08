'use strict';
jest.mock('../../src/services/images/imageService', () => ({}));
jest.mock('../../src/services/images/workshopPresentation', () => ({}));
const fs = require('node:fs');
const path = require('node:path');
const { mount } = require('../../routes/local-images');
const root = path.join(__dirname, '..', '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');

test('the guide is a page of the workshop and loads its own assets', () => {
  const pages = {}; mount({ use: jest.fn(), get: (route, handler) => { pages[route] = handler; } });
  const render = jest.fn(); pages['/images/guide']({}, { render });
  expect(render).toHaveBeenCalledWith('layouts/main', expect.objectContaining({ pageView: '../pages/images-guide', activePage: 'images' }));
  const options = render.mock.calls[0][1];
  expect(options.headCss).toContain('/css/local-images-guide.css'); expect(options.footerJs).toContain('/js/local-images-guide.js');
  expect(fs.existsSync(path.join(root, 'views/pages/images-guide.ejs'))).toBe(true);
});
test('the workshop links to the guide and the guide links back', () => {
  expect(read('views/pages/images.ejs')).toContain('href="/images/guide"');
  expect(read('views/pages/images-guide.ejs')).toContain('href="/images"');
});
test('host, card and recipes come from the live configuration, never from the page source', () => {
  const view = read('views/pages/images-guide.ejs'), script = read('public/js/local-images-guide.js');
  for (const id of ['guide-host', 'guide-gpu', 'guide-vram', 'guide-recipes', 'guide-recipes-status']) expect(view).toContain(`id="${id}"`);
  expect(script).toContain("fetch('/api/images/workshop')");
  expect(view).not.toMatch(/UGFrank|UGAlien|Brutal|RTX|\d+\.\d+\.\d+\.\d+|safetensors|qwen|klein/i);
});
test('the guide quotes the messages the service and the workshop really show', () => {
  const view = read('views/pages/images-guide.ejs'), client = read('public/js/local-images.js');
  expect(read('src/services/images/gpuReservation.js')).toContain('GPU occupé');
  expect(read('src/services/images/imageService.js')).toContain('Le PC image est indisponible ou occupé');
  for (const text of ['État incertain', 'archivage doit être repris']) { expect(client).toContain(text); expect(view).toContain(text); }
  for (const stage of ['Préparation', 'Calcul', 'Archivage', 'Restitution']) { expect(read('views/pages/images.ejs')).toContain(`<li>${stage}</li>`); expect(view).toContain(stage); }
});
