'use strict';

// Shared coordinate validation and selection. No geolocation, persistence or
// network calls: each service supplies its existing known-location read.
function invalid(message, status = 400) {
  return Object.assign(new Error(message), { code: 'INVALID_POSITION', status });
}

function parsePosition(value = {}) {
  const { lat, lon } = value;
  if (lat === undefined && lon === undefined) return null;
  const decimal = (n) => (typeof n === 'number' && Number.isFinite(n))
    || (typeof n === 'string' && n.trim() !== '' && /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(n.trim()));
  if (!decimal(lat) || !decimal(lon) || Math.abs(Number(lat)) > 90 || Math.abs(Number(lon)) > 180) {
    throw invalid('lat and lon must both be decimal degrees (lat -90..90, lon -180..180)');
  }
  return { lat: Number(lat), lon: Number(lon) };
}

function resolvePosition({ explicit = null, known = null, defaultLocationJson = '' } = {}) {
  if (explicit) return { ...parsePosition(explicit), source: 'explicit', label: null };
  try {
    const position = known && parsePosition(known);
    if (position) return { ...position, source: 'known', label: null };
  } catch (_) { /* An unusable stored position does not become 0,0. */ }
  if (!String(defaultLocationJson).trim()) return null;
  try {
    const fallback = JSON.parse(defaultLocationJson);
    if (!fallback || typeof fallback !== 'object' || Array.isArray(fallback)) throw invalid('invalid default');
    const position = parsePosition(fallback);
    if (!position) throw invalid('missing default');
    const label = typeof fallback.name === 'string'
      ? fallback.name.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 80) || null : null;
    return { ...position, source: 'default', label };
  } catch (_) {
    // Never echo the configuration or its coordinates into logs/errors.
    throw invalid('OBSERVER_DEFAULT_LOCATION_JSON must define valid lat and lon', 503);
  }
}

function locationMetadata(position) {
  return { source: position.source, label: position.label || {
    explicit: 'coordonnées fournies', known: 'lieu météo configuré', default: 'lieu par défaut configuré'
  }[position.source], defaulted: position.source === 'default' };
}

module.exports = { parsePosition, resolvePosition, locationMetadata };
