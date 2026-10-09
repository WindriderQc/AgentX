'use strict';

/**
 * Toolbox relays for three Data capabilities: downloadable reports
 * (/api/v1/exports), storage growth trends (/api/v1/storage/trends) and the
 * activity log (/api/v1/events).
 *
 * Two writes live here: generating a report and deleting one. A report is a
 * file Data writes in its own report store; nothing here touches the scanned
 * disks. The download is piped from Data to the browser without being held in
 * memory: a full report of a large inventory weighs tens of megabytes.
 */

const { Readable } = require('stream');
const { pipeline } = require('stream/promises');
const { openDataStream } = require('../../src/services/dataServiceClient');

// These mirror data/services/exportStore.js and data/services/activityLog.js,
// which Core cannot load from the Data service; the tests compare them.
const REPORT_TYPES = Object.freeze(['full', 'summary', 'media', 'large', 'stats']);
const REPORT_FORMATS = Object.freeze(['json', 'csv']);
const REPORT_NAME = /^export_(full|summary|media|large|stats)_\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}_[0-9a-f]{6}\.(json|csv)$/;
const REPORT_NAME_MAX = 80;
const REPORT_CONTENT_TYPES = Object.freeze({ json: 'application/json; charset=utf-8', csv: 'text/csv; charset=utf-8' });
const EVENT_SEVERITIES = Object.freeze(['info', 'warning', 'error']);
const EVENT_TYPE_PREFIX = /^[a-z][a-z0-9_.]{0,63}$/;
const EVENT_MAX_PAGE = 500;
const EVENT_MAX_LIMIT = 200;
const TREND_MAX_FOLDER_SERIES = 42;
// A report is read at disk speed, but a slow link may take minutes for one.
const DOWNLOAD_TIMEOUT_MS = 15 * 60 * 1000;

function invalid(message) {
  const error = new Error(message);
  error.status = 400;
  return error;
}

/** `{ type, format }` of a name Data's exporter creates, else null. */
function parseReportName(value) {
  if (typeof value !== 'string' || value.length > REPORT_NAME_MAX) return null;
  const match = REPORT_NAME.exec(value);
  return match ? { filename: value, type: match[1], format: match[2] } : null;
}

/** The body of a generation request: exactly `{ type, format }`, both named. */
function validateReportRequest(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw invalid('Expected a JSON object with two fields: type, format');
  const unknown = Object.keys(body).filter((key) => key !== 'type' && key !== 'format');
  if (unknown.length) throw invalid(`Unknown field ${unknown.slice(0, 3).map((key) => JSON.stringify(key.slice(0, 40))).join(', ')}: expected type, format`);
  const { type, format } = body;
  if (typeof type !== 'string' || !REPORT_TYPES.includes(type)) throw invalid(`type must be one of ${REPORT_TYPES.join(', ')}`);
  if (typeof format !== 'string' || !REPORT_FORMATS.includes(format)) throw invalid(`format must be one of ${REPORT_FORMATS.join(', ')}`);
  if (type === 'full' && format !== 'json') throw invalid('A full report is available in JSON only');
  return { type, format };
}

function single(value) {
  const raw = Array.isArray(value) ? value[0] : value;
  return raw === undefined || raw === null || raw === '' ? null : String(raw);
}

function boundedPage(value, name, max) {
  if (!/^\d{1,6}$/.test(value)) throw invalid(`${name} must be a whole number from 1 to ${max}`);
  return String(Math.min(max, Math.max(1, Number(value))));
}

function eventDate(value, name) {
  const valid = value.length <= 40 && (/^\d{10,15}$/.test(value) || Number.isFinite(new Date(value).getTime()));
  if (!valid) throw invalid(`${name} must be an ISO date or a time in milliseconds`);
  return value;
}

/** The query of an activity read: only Data's own filters, each checked. */
function eventQuery(query = {}) {
  const selected = new URLSearchParams();
  const type = single(query.type);
  if (type !== null) {
    if (!EVENT_TYPE_PREFIX.test(type)) throw invalid('type must be an event type or the beginning of one, such as storage. or storage.scan_');
    selected.set('type', type);
  }
  const severity = single(query.severity);
  if (severity !== null) {
    if (!EVENT_SEVERITIES.includes(severity)) throw invalid(`severity must be one of ${EVENT_SEVERITIES.join(', ')}`);
    selected.set('severity', severity);
  }
  for (const name of ['since', 'until']) {
    const value = single(query[name]);
    if (value !== null) selected.set(name, eventDate(value, name));
  }
  const page = single(query.page);
  if (page !== null) selected.set('page', boundedPage(page, 'page', EVENT_MAX_PAGE));
  const limit = single(query.limit);
  if (limit !== null) selected.set('limit', boundedPage(limit, 'limit', EVENT_MAX_LIMIT));
  return selected.toString();
}

function refuse(res, status, code, message) {
  return res.status(status).json({ ok: false, status: 'error', code, message });
}

/** Data's own refusal of a download is a small JSON body: read at most 4 KiB of it. */
async function refusalMessage(response) {
  try {
    if (!/json/i.test(response.headers.get('content-type') || '') || !response.body) return null;
    let text = '';
    const decoder = new TextDecoder();
    for await (const chunk of response.body) {
      text += decoder.decode(chunk, { stream: true });
      if (text.length > 4096) return null;
    }
    const message = JSON.parse(text)?.message;
    return typeof message === 'string' ? message.slice(0, 300) : null;
  } catch { return null; }
}

function mount(router, { relay, fetchData, timeoutMs }) {
  const failed = (res, error, uncertain) => {
    const timedOut = error.name === 'TimeoutError';
    return refuse(res, 502, timedOut ? 'DATA_TIMEOUT' : 'DATA_UNAVAILABLE', timedOut ? uncertain : error.message);
  };

  router.get('/storage/trends', relay(() => '/api/v1/storage/trends', {
    root: { maxLength: 1024 }, folder: { maxLength: 600 }, from: { maxLength: 40 }, to: { maxLength: 40 },
    limit: { type: 'int', fallback: 12, min: 1, max: TREND_MAX_FOLDER_SERIES }
  }));

  // The activity log is read only: the page never records an event of its own.
  router.get('/events', async (req, res) => {
    let query;
    try { query = eventQuery(req.query); }
    catch (error) { return refuse(res, 400, 'INVALID_EVENT_QUERY', error.message); }
    try {
      const { response, body } = await fetchData('/api/v1/events', { query });
      return res.status(response.status).json(body);
    } catch (error) { return failed(res, error, 'Data service request timed out'); }
  });

  router.get('/reports', relay(() => '/api/v1/exports'));
  // Report write 1 of 2: start one generation. Only the checked type and
  // format are forwarded. Data answers 202 at once with the report's name, or
  // 429 when two reports are already being generated.
  router.post('/reports', async (req, res) => {
    let request;
    try { request = validateReportRequest(req.body); }
    catch (error) { return refuse(res, 400, 'INVALID_REPORT_REQUEST', error.message); }
    try {
      const { response, body } = await fetchData('/api/v1/exports/generate', { method: 'POST', payload: request });
      return res.status(response.status).json(body);
    } catch (error) { return failed(res, error, 'Data did not answer in time: the report may or may not have been started'); }
  });
  // Report write 2 of 2: delete one report, or clear a failed generation from
  // the list. Only a name the exporter creates is forwarded.
  router.delete('/reports/:filename', async (req, res) => {
    const report = parseReportName(req.params.filename);
    if (!report) return refuse(res, 400, 'INVALID_REPORT_NAME', 'Invalid report name');
    try {
      const { response, body } = await fetchData(`/api/v1/exports/${report.filename}`, { method: 'DELETE' });
      return res.status(response.status).json(body);
    } catch (error) { return failed(res, error, 'Data did not answer in time: the report may or may not have been deleted'); }
  });
  // The download is piped: Data's bytes go to the browser as they arrive, and
  // a browser that stops reading slows the read from Data instead of filling
  // memory. A browser that leaves ends the request to Data.
  router.get('/reports/:filename/download', async (req, res) => {
    const report = parseReportName(req.params.filename);
    if (!report) return refuse(res, 400, 'INVALID_REPORT_NAME', 'Invalid report name');
    let upstream;
    try {
      upstream = await openDataStream(`/api/v1/exports/${report.filename}/download`, { headerTimeoutMs: timeoutMs(), totalTimeoutMs: DOWNLOAD_TIMEOUT_MS });
    } catch (error) { return failed(res, error, 'Data service request timed out'); }
    const { response } = upstream;
    if (!response.ok || !response.body) {
      const message = await refusalMessage(response);
      upstream.close();
      return refuse(res, response.status >= 400 ? response.status : 502, 'REPORT_UNAVAILABLE', message || `Data answered ${response.status} for this report`);
    }
    const type = response.headers.get('content-type') || '';
    const length = response.headers.get('content-length') || '';
    res.status(200);
    res.setHeader('Content-Type', /^(application\/json|text\/csv)\b/i.test(type) ? type : REPORT_CONTENT_TYPES[report.format]);
    if (/^\d{1,15}$/.test(length)) res.setHeader('Content-Length', length);
    // The name matched the exporter's pattern: no quote, slash or control character.
    res.setHeader('Content-Disposition', `attachment; filename="${report.filename}"`);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Cache-Control', 'no-store');
    res.on('close', () => upstream.close());
    try {
      await pipeline(Readable.fromWeb(response.body), res);
    } catch {
      // The headers are gone: a cut connection tells the browser the file is incomplete.
      res.destroy();
    } finally { upstream.close(); }
    return undefined;
  });
}

module.exports = {
  mount,
  parseReportName,
  validateReportRequest,
  eventQuery,
  REPORT_TYPES,
  REPORT_FORMATS,
  REPORT_NAME,
  REPORT_CONTENT_TYPES,
  EVENT_SEVERITIES,
  EVENT_MAX_PAGE,
  EVENT_MAX_LIMIT,
  TREND_MAX_FOLDER_SERIES,
  DOWNLOAD_TIMEOUT_MS
};
