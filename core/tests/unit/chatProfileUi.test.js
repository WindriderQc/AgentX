'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const profilePath = path.resolve(__dirname, '../../public/js/chat/chat-profile.js');

// Load the browser ES module in a sandbox: imports become injected stubs.
function loadProfileModule(fetchWithDeadline) {
  const source = fs.readFileSync(profilePath, 'utf8')
    .replace(/^import .*$/gm, '')
    .replace(/^export (async )?function /gm, '$1function ');
  const context = {
    console: { warn: jest.fn(), error: jest.fn() },
    document: { body: { dataset: {} }, getElementById: () => null },
    window: {},
    fetchWithDeadline,
    showModal: jest.fn()
  };
  vm.runInNewContext(`${source}\nthis.api = { loadProfile, saveProfile };`, context, { filename: 'chat-profile.js' });
  return context.api;
}

function field(value = '') {
  return { value };
}

function profileElements() {
  return {
    profileModal: { classList: { add: jest.fn(), remove: jest.fn() }, setAttribute: jest.fn(), removeAttribute: jest.fn() },
    userAbout: field('Engineer.'),
    userInstructions: field('Be brief.'),
    memoryLanguage: field(' Français '),
    memoryRole: field('Operator'),
    memoryStyle: field('Concise.')
  };
}

describe('Playground profile save and load', () => {
  test('sends every profile field and reports success only on an OK response', async () => {
    const fetchWithDeadline = jest.fn().mockResolvedValue({ ok: true, status: 200 });
    const { saveProfile } = loadProfileModule(fetchWithDeadline);
    const setFeedback = jest.fn();
    const elements = profileElements();

    await saveProfile(elements, setFeedback);

    const [, options] = fetchWithDeadline.mock.calls[0];
    expect(JSON.parse(options.body)).toEqual({
      about: 'Engineer.',
      preferences: { customInstructions: 'Be brief.', language: 'Français', role: 'Operator', style: 'Concise.' }
    });
    expect(setFeedback).toHaveBeenCalledWith('Profile saved.', 'success');
    expect(elements.profileModal.classList.add).toHaveBeenCalledWith('hidden');
  });

  test('shows the server error and keeps the dialog open when the save is rejected', async () => {
    const fetchWithDeadline = jest.fn().mockResolvedValue({
      ok: false,
      status: 400,
      json: async () => ({ status: 'error', message: 'preferences.style must be at most 1000 characters' })
    });
    const { saveProfile } = loadProfileModule(fetchWithDeadline);
    const setFeedback = jest.fn();
    const elements = profileElements();

    await saveProfile(elements, setFeedback);

    expect(setFeedback).toHaveBeenCalledWith('Profile not saved: preferences.style must be at most 1000 characters', 'error');
    expect(setFeedback).not.toHaveBeenCalledWith('Profile saved.', 'success');
    expect(elements.profileModal.classList.add).not.toHaveBeenCalled();
  });

  test('falls back to the HTTP status when the error body is not JSON', async () => {
    const fetchWithDeadline = jest.fn().mockResolvedValue({
      ok: false,
      status: 503,
      json: async () => { throw new SyntaxError('Unexpected token'); }
    });
    const { saveProfile } = loadProfileModule(fetchWithDeadline);
    const setFeedback = jest.fn();

    await saveProfile(profileElements(), setFeedback);

    expect(setFeedback).toHaveBeenCalledWith('Profile not saved: HTTP 503', 'error');
  });

  test('loads language, role and style from the stored profile into the form', async () => {
    const fetchWithDeadline = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        status: 'success',
        data: {
          about: 'Stored about.',
          preferences: { customInstructions: 'Stored rules.', language: 'English', role: 'Parent', style: 'Warm.' }
        }
      })
    });
    const { loadProfile } = loadProfileModule(fetchWithDeadline);
    const elements = profileElements();

    await loadProfile(elements);

    expect(elements.userAbout.value).toBe('Stored about.');
    expect(elements.userInstructions.value).toBe('Stored rules.');
    expect(elements.memoryLanguage.value).toBe('English');
    expect(elements.memoryRole.value).toBe('Parent');
    expect(elements.memoryStyle.value).toBe('Warm.');
  });
});
