'use strict';

// Owner-visible state of the speech engines (Nestor's cloned voice runs on the
// VoxCPM2 worker, the catalog voices on Kokoro), read from VoiX's voice catalog,
// with the time each one last changed state. The time lives in this Core process:
// after a restart it starts again from the first reading.

const ENGINES = Object.freeze(['voxcpm', 'kokoro']);
const clean = (value) => String(value || '').replace(/\s+/g, ' ').trim().slice(0, 160);

function createVoiceStatus({ readCatalog, now = () => Date.now() }) {
  const changed = new Map();
  return async function voiceStatus() {
    let providers = null, failure = '';
    try {
      const catalog = await readCatalog();
      providers = Array.isArray(catalog?.providers) ? catalog.providers : null;
      if (!providers) failure = 'VoiX voice catalog is unavailable';
    } catch (error) { failure = clean(error.message) || 'VoiX voice catalog is unavailable'; }
    const engines = {};
    for (const id of ENGINES) {
      const provider = providers?.find((entry) => entry?.id === id);
      const ready = providers ? provider?.available === true : null;
      const previous = changed.get(id);
      if (!previous || previous.ready !== ready) changed.set(id, { ready, since: new Date(now()).toISOString() });
      engines[id] = { configured: providers ? Boolean(provider) : null, ready,
        reason: providers ? clean(provider?.reason) : failure, since: changed.get(id).since };
    }
    return engines;
  };
}

// One French line for the owner, empty when everything speaks.
function voiceLine(engines, format = (iso) => new Date(iso).toLocaleTimeString('fr-CA', { hour: '2-digit', minute: '2-digit' })) {
  const voxcpm = engines?.voxcpm;
  if (!voxcpm?.configured || voxcpm.ready !== false) return '';
  return `Voix de Nestor (Gazz) indisponible depuis ${format(voxcpm.since)}${engines.kokoro?.ready ? ' · voix de secours Kokoro' : ''}`;
}

module.exports = { createVoiceStatus, voiceLine };
