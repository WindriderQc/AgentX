'use strict';
const { createHash } = require('node:crypto');
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const fail = (message, statusCode = 400, code = 'TRANSCRIPTION_INVALID') => Object.assign(new Error(message), { statusCode, code });
function youtubeUrl(value) {
  if (typeof value !== 'string' || value.length > 2048) throw fail('Collez une URL YouTube valide.');
  let url;
  try { url = new URL(value); } catch { throw fail('Collez une URL YouTube valide.'); }
  if (url.protocol !== 'https:' || url.username || url.password || (url.port && url.port !== '443')) throw fail('Utilisez une URL YouTube HTTPS publique.');
  let id = '';
  if (url.hostname === 'youtu.be') id = url.pathname.slice(1);
  else if (['youtube.com', 'www.youtube.com', 'm.youtube.com'].includes(url.hostname)) {
    if (url.pathname === '/watch') id = url.searchParams.get('v');
    else if (/^\/(shorts|live)\/[^/]+$/.test(url.pathname)) id = url.pathname.split('/')[2];
  }
  if (!/^[\w-]{11}$/.test(id || '')) throw fail('Choisissez une vidéo YouTube, pas une playlist ou une autre adresse.');
  return 'https://www.youtube.com/watch?v=' + id;
}
function intent(body) {
  if (!UUID.test(body?.requestKey || '')) throw fail('Identité de demande invalide.');
  const url = youtubeUrl(body.url), language = body.language || 'auto';
  if (!['auto', 'fr', 'en', 'fr-en'].includes(language)) throw fail('Langue invalide.');
  if (body.retryOf && !UUID.test(body.retryOf)) throw fail('Référence de nouvelle tentative invalide.');
  const timeZone = body.timeZone;
  try { if (!timeZone || typeof timeZone !== 'string') throw Error(); new Intl.DateTimeFormat('fr', { timeZone }).format(); }
  catch { throw fail('Choisissez un fuseau horaire valide.'); }
  const requestedAt = body.startAt || null;
  if (requestedAt && (typeof requestedAt !== 'string' || !/T.*(?:Z|[+-]\d\d:\d\d)$/.test(requestedAt) || !Number.isFinite(Date.parse(requestedAt)))) {
    throw fail('La date doit préciser son décalage UTC.');
  }
  if (requestedAt) {
    const key = requestedAt.slice(0, 10);
    if (new Date(key + 'T00:00:00Z').toISOString().slice(0, 10) !== key) throw fail('Date invalide.');
  }
  const request = { url, language, timeZone, requestedAt: requestedAt ? new Date(requestedAt).toISOString() : null, retryOf: body.retryOf || null };
  return { ...request, id: body.requestKey, intentHash: createHash('sha256').update(JSON.stringify(request)).digest('hex') };
}
function config() {
  const base = String(process.env.VOIX_BASE_URL || '').replace(/\/+$/, '');
  if (process.env.TRANSCRIPTIONS_ENABLED !== 'true' || !base) throw fail('Les transcriptions longues ne sont pas configurées sur cette instance.', 503, 'TRANSCRIPTIONS_NOT_CONFIGURED');
  const url = new URL(base);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash || url.pathname !== '/') throw fail('Configuration du service vocal invalide.', 503);
  const { resourceTopology, resourcesFor } = require('./runtimePhysicalResources');
  const { hostUrlKey } = require('../../../shared/ollamaHostConfig');
  if (!resourcesFor(resourceTopology(), [hostUrlKey(base)]).length) throw fail('Associez le service vocal à sa ressource physique dans la configuration native avant d’activer les transcriptions.', 503, 'TRANSCRIPTION_RESOURCE_UNMAPPED');
  const hosts = process.env.TRANSCRIPTION_RESOURCE_HOSTS ? JSON.parse(process.env.TRANSCRIPTION_RESOURCE_HOSTS) : [base];
  const minutes = Number(process.env.TRANSCRIPTION_RESERVATION_MINUTES || 180);
  if (!Number.isInteger(minutes) || minutes < 1 || minutes > 10080) throw fail('Budget de réservation invalide.', 503);
  return { base, hosts: [...new Set([base, ...hosts])], minutes };
}
const timestamp = seconds => {
  const ms = Math.max(0, Math.round(Number(seconds) * 1000));
  return new Date(ms).toISOString().slice(11, 23).replace('.', ',');
};
function srt(segments = []) {
  return segments.map((s, i) => `${i + 1}\n${timestamp(s.start)} --> ${timestamp(s.end)}\n${s.text}\n`).join('\n');
}
module.exports = { UUID, fail, youtubeUrl, intent, config, srt };
