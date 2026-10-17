/* Browser-owned voice settings. Existing presentation owners keep their keys. */
(function (root, factory) {
  const api = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.AgentXVoiceSettings = api;
})(typeof window === 'undefined' ? globalThis : window, function (root) {
  'use strict';
  const SCOPES = ['personal', 'family', 'reading', 'psyx'];
  const DEFAULTS = Object.freeze({ threshold: .015, minimumVoiceMs: 100, endSilenceMs: 1000, interruptionSilenceMs: 250 });
  const LIMITS = Object.freeze({ threshold: [.002, .15], minimumVoiceMs: [40, 400], endSilenceMs: [400, 2000], interruptionSilenceMs: [100, 700] });
  const scope = value => SCOPES.includes(value) ? value : 'personal';
  const storage = () => { try { return root.localStorage; } catch { return null; } };
  const json = (store, key) => { try { const x = JSON.parse(store?.getItem(key) || '{}'); return x && !Array.isArray(x) && typeof x === 'object' ? x : {}; } catch { return {}; } };
  function normalize(value = {}, strict = false) {
    const result = {};
    for (const [key, fallback] of Object.entries(DEFAULTS)) {
      const n = value[key], [min, max] = LIMITS[key];
      if (n !== undefined && (typeof n !== 'number' || !Number.isFinite(n) || n < min || n > max)) {
        if (strict) throw new Error(`Invalid capture setting: ${key}`);
      }
      result[key] = typeof n === 'number' && Number.isFinite(n) && n >= min && n <= max ? n : fallback;
    }
    return result;
  }
  function inputDevice(context, store = storage()) { const value = json(store, scope(context) === 'psyx' ? 'psyx.voice.preferences.v1' : 'agentx.voice.capture.v1.' + scope(context)).inputDeviceId; return typeof value === 'string' && value.length <= 256 ? value : ''; }
  function capture(context, store = storage()) { return normalize(json(store, 'agentx.voice.capture.v1.' + scope(context))); }
  function writeCapture(context, value, store = storage()) {
    const selected = normalize(value, true);
    if (value.inputDeviceId !== undefined && (typeof value.inputDeviceId !== 'string' || value.inputDeviceId.length > 256)) throw new Error('Invalid microphone identifier');
    if (scope(context) !== 'psyx') selected.inputDeviceId = value.inputDeviceId ?? inputDevice(context, store);
    if (!store) throw new Error('This browser cannot save preferences.');
    store.setItem('agentx.voice.capture.v1.' + scope(context), JSON.stringify(selected));
    return selected;
  }
  function read(context, personas = [], store = storage()) {
    context = scope(context);
    if (context === 'psyx') {
      const module = root.PsyXVoicePreferences;
      const prefs = module ? module.readPreferences(store) : json(store, 'psyx.voice.preferences.v1');
      return { language: prefs.language === 'en' ? 'en' : 'fr', voice: prefs.ttsVoice ? prefs.ttsProvider + '|' + prefs.ttsVoice : '',
        inputDeviceId: prefs.inputDeviceId || '', wakeWord: false, interruption: false,
        spokenReplies: prefs.spokenReplies === true, autoSend: prefs.autoSend === true, owner: 'PsyX · ce navigateur', capture: capture(context, store) };
    }
    if (context === 'reading') {
      let lang; try { lang = store?.getItem('household.reading.language.v1'); } catch {}
      const language = lang === 'en' ? 'en' : 'fr', voices = json(store, 'household.reading.voices.v1');
      return { language, voice: validVoice(voices[language]) ? voices[language] : '', inputDeviceId: inputDevice(context, store), wakeWord: true, interruption: true,
        owner: 'Kids Room et Lecture · ce navigateur', capture: capture(context, store) };
    }
    const P = root.PersonaPresentation;
    const prefs = P?.read(store, personas) || json(store, 'household.conversation.preferences.v2');
    const personaId = context === 'family' ? 'nestor' : prefs.personaId || 'nestor';
    const profile = prefs.profiles?.[personaId] || {};
    let listening; try { listening = store?.getItem('household.space.' + context + '.listening'); } catch {}
    const language = profile.language === 'en' ? 'en' : 'fr';
    return { language, personaId, voice: validVoice(profile.selections?.[language]) ? profile.selections[language] : '', inputDeviceId: inputDevice(context, store),
      wakeWord: ['wake', 'open'].includes(listening) ? listening === 'wake' : context === 'family', interruption: prefs.interruption !== false,
      linksClickable: context === 'family' ? familyLinks(store) === 'clickable' : true,
      owner: 'Présentation Nestor · ce navigateur · partagée entre Personnel et Famille', capture: capture(context, store) };
  }
  const FAMILY_LINKS_KEY = 'household.space.family.links';
  function familyLinks(store) { try { return store?.getItem(FAMILY_LINKS_KEY); } catch { return null; } }
  function validVoice(value) { return typeof value === 'string' && /^(kokoro|windows_sapi|voxcpm)\|[^\r\n]{1,120}$/.test(value); }
  function write(context, patch, personas = [], store = storage()) {
    context = scope(context);
    if (!store) throw new Error('This browser cannot save preferences.');
    const language = patch.language === 'en' ? 'en' : 'fr';
    if (patch.voice && !validVoice(patch.voice)) throw new Error('Select an installed voice.');
    if (context === 'psyx') {
      const module = root.PsyXVoicePreferences;
      if (!module) throw new Error('PsyX preferences are unavailable.');
      const prefs = module.readPreferences(store), separator = (patch.voice || '').indexOf('|');
      const next = module.normalizePreferences({ ...prefs, language, ttsVoice: separator >= 0 ? patch.voice.slice(separator + 1) : '',
        ttsProvider: separator >= 0 ? patch.voice.slice(0, separator) : prefs.ttsProvider,
        inputDeviceId: patch.inputDeviceId || '', spokenReplies: patch.spokenReplies === true, autoSend: patch.autoSend === true });
      store.setItem(module.STORAGE_KEY, JSON.stringify(next));
    } else if (context === 'reading') {
      const voices = json(store, 'household.reading.voices.v1');
      if (patch.voice) voices[language] = patch.voice; else delete voices[language];
      store.setItem('household.reading.voices.v1', JSON.stringify(voices));
      store.setItem('household.reading.language.v1', language);
    } else {
      const P = root.PersonaPresentation;
      if (!P) throw new Error('Nestor preferences are unavailable.');
      const prefs = P.read(store, personas), id = patch.personaId || (context === 'family' ? 'nestor' : prefs.personaId);
      if (!personas.some(p => p.id === id)) throw new Error('Select an available personality.');
      const old = prefs.profiles[id] || {}, selections = { ...(old.selections || {}) };
      if (patch.voice) selections[language] = patch.voice; else delete selections[language];
      prefs.profiles[id] = P.profile({ ...old, language, selections });
      prefs.interruption = patch.interruption !== false;
      if (!P.save(store, prefs)) throw new Error('This browser could not save Nestor preferences.');
      store.setItem('household.space.' + context + '.listening', patch.wakeWord ? 'wake' : 'open');
      // Famille shows external links as plain text unless this is turned on.
      if (context === 'family') store.setItem(FAMILY_LINKS_KEY, patch.linksClickable ? 'clickable' : 'text');
    }
    return read(context, personas, store);
  }
  function save(context, patch, captureSettings, personas = [], store = storage()) {
    if (!store) throw new Error('This browser cannot save preferences.');
    const staged = new Map(), stage = { getItem: key => staged.has(key) ? staged.get(key) : store.getItem(key), setItem: (key,value) => staged.set(key,value) };
    write(context, patch, personas, stage); writeCapture(context, { ...captureSettings, inputDeviceId: patch.inputDeviceId || '' }, stage);
    const old = new Map([...staged.keys()].map(key => [key,store.getItem(key)])), written = [];
    try { for (const [key,value] of staged) { store.setItem(key,value); written.push(key); } }
    catch (error) {
      let rolledBack = true;
      for (const key of written.reverse()) try { if (store.getItem(key) === staged.get(key)) { if (old.get(key) === null) store.removeItem(key); else store.setItem(key,old.get(key)); } } catch { rolledBack = false; }
      throw new Error(rolledBack ? 'The browser could not save these choices. Previous values are preserved.' : 'The browser refused storage and could not restore every choice. Reload the workshop to inspect the saved values.');
    }
    return read(context, personas, store);
  }
  async function microphones(signal, { requestPermission = true } = {}) {
    let stream;
    try {
      signal?.throwIfAborted();
      if (requestPermission) stream = await root.navigator.mediaDevices.getUserMedia({ audio:true });
      signal?.throwIfAborted();
      const devices = await root.navigator.mediaDevices.enumerateDevices();
      signal?.throwIfAborted();
      return devices.filter(device => device.kind === 'audioinput');
    } finally { stream?.getTracks().forEach(track => track.stop()); }
  }
  return { microphones, save, inputDevice, SCOPES, DEFAULTS, LIMITS, normalize, capture, writeCapture, read, write, validVoice };
});
