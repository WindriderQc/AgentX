'use strict';

const { photoError, readApiKey } = require('./immichClient');

// Stream the fixed playback endpoint with backpressure; never buffer a full video.
// The timeout covers headers. The response owner aborts the body on disconnect.
async function streamVideo({ settings, fetchImpl, readFile, id, range, signal }) {
  if (range !== undefined && (typeof range !== 'string' || range.length > 100 || !/^bytes=\d*-\d*$/.test(range) || range === 'bytes=-'))
    throw photoError(400, 'PHOTOS_BAD_REQUEST', 'Expected a single byte range');
  const current = settings();
  if (!current.enabled) throw photoError(503, 'PHOTOS_NOT_CONFIGURED', 'Photos are not configured');
  const timeout = new AbortController(), timer = setTimeout(() => timeout.abort(), current.timeoutMs);
  let response;
  try {
    response = await fetchImpl(`${current.url}/api/assets/${id}/video/playback`, {
      headers: { 'x-api-key': readApiKey(current.keyFile, readFile), accept: 'video/*', ...(range ? { range } : {}) },
      redirect: 'error', signal: signal ? AbortSignal.any([signal, timeout.signal]) : timeout.signal,
    });
  } catch (error) {
    if (error.code?.startsWith('PHOTOS_')) throw error;
    throw photoError(502, 'PHOTOS_VIDEO_UNAVAILABLE', 'Video playback is unavailable');
  } finally { clearTimeout(timer); }
  const contentType = String(response.headers.get('content-type') || '').split(';')[0].trim();
  if (response.status === 416) {
    await response.body?.cancel();
    throw photoError(416, 'PHOTOS_RANGE_UNAVAILABLE', 'Video byte range is unavailable');
  }
  if (![200, 206].includes(response.status) || !/^video\/[a-z0-9.+-]+$/i.test(contentType) || !response.body) {
    await response.body?.cancel();
    throw photoError(502, 'PHOTOS_VIDEO_UNAVAILABLE', 'Video is not ready for playback');
  }
  const headers = { 'Content-Type': contentType, 'Content-Disposition': 'inline', 'X-Content-Type-Options': 'nosniff' };
  for (const key of ['content-length', 'content-range', 'accept-ranges']) {
    const value = response.headers.get(key);
    if (value) headers[key] = value;
  }
  return { status: response.status, headers, body: response.body };
}
module.exports = { streamVideo };
