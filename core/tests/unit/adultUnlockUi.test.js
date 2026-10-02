'use strict';

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.resolve(__dirname, '../../public/access/unlock.js'), 'utf8');
const settle = () => new Promise(resolve => setImmediate(resolve));

function load({ length = 6, replies = [] } = {}) {
  const codeListeners = {};
  const formListeners = {};
  const code = { value: '', maxLength: 128, focus: jest.fn(), addEventListener: (name, callback) => { codeListeners[name] = callback; } };
  const button = { disabled: false };
  const status = { textContent: '' };
  const form = {
    addEventListener: (name, callback) => { formListeners[name] = callback; },
    querySelector: () => button,
    requestSubmit: jest.fn(() => formListeners.submit({ preventDefault() {} }))
  };
  const location = { search: '?next=%2Fdad', replace: jest.fn() };
  const fetch = jest.fn(url => {
    if (url === '/api/access/session') return Promise.resolve({ ok: true, json: async () => ({ data: { numericCodeLength: length } }) });
    return Promise.resolve(replies.shift());
  });
  vm.runInNewContext(source, {
    document: { getElementById: id => ({ parentalCode: code, unlockForm: form, unlockStatus: status })[id] },
    fetch, location, URLSearchParams, Number
  });
  return { code, codeListeners, form, formListeners, button, status, fetch, location };
}

test('numeric code submits once on its final digit and follows the requested destination', async () => {
  const ui = load({ replies: [{ ok: true, json: async () => ({ data: { next: '/dad' } }) }] });
  await settle();
  expect(ui.code.maxLength).toBe(6);
  ui.code.value = '73925';
  ui.codeListeners.input({});
  expect(ui.fetch).toHaveBeenCalledTimes(1);
  ui.code.value = '739251';
  ui.codeListeners.input({});
  ui.codeListeners.change({});
  expect(ui.form.requestSubmit).toHaveBeenCalledTimes(1);
  expect(JSON.parse(ui.fetch.mock.calls[1][1].body)).toEqual({ code: '739251', next: '/dad' });
  await settle();
  expect(ui.location.replace).toHaveBeenCalledWith('/dad');
});

test('a failed automatic attempt clears the field and allows a new attempt', async () => {
  const ui = load({ replies: [
    { ok: false, status: 403, json: async () => ({ message: 'Code invalide.' }) },
    { ok: true, json: async () => ({ data: { next: '/dad' } }) }
  ] });
  await settle();
  ui.code.value = '000000';
  ui.codeListeners.input({});
  await settle();
  expect(ui.status.textContent).toBe('Code invalide.');
  expect(ui.code.value).toBe('');
  expect(ui.button.disabled).toBe(false);
  ui.code.value = '739251';
  ui.codeListeners.input({});
  await settle();
  expect(ui.fetch).toHaveBeenCalledTimes(3);
  expect(ui.location.replace).toHaveBeenCalledWith('/dad');
});

test('non-numeric codes keep the manual submit path', async () => {
  const ui = load({ length: null, replies: [{ ok: true, json: async () => ({ data: { next: '/dad' } }) }] });
  await settle();
  ui.code.value = 'secret';
  ui.codeListeners.input({});
  expect(ui.form.requestSubmit).not.toHaveBeenCalled();
  await ui.formListeners.submit({ preventDefault() {} });
  expect(JSON.parse(ui.fetch.mock.calls[1][1].body).code).toBe('secret');
});
