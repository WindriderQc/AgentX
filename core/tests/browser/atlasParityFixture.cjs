'use strict';
// Disposable synthetic HTTP fixture; never proxies a real household or model.
const http = require('node:http');
const fs = require('node:fs/promises');
const path = require('node:path');
const { createHash } = require('node:crypto');
const root = path.resolve(__dirname, '../../surfaces/household/public/atlas');
const digest = text => createHash('sha256').update(text).digest('hex');
const entryId = n => n.toString(16).padStart(24, 'a');
const assetId = n => `12345678-abcd-1234-abcd-${String(n).padStart(12, '0')}`;
const body = 'Synthetic source: I moved to this home in spring. The exact day is unknown.';
function fixtureEntries() {
  const categories = ['home', 'work', 'people', 'travel', 'health', 'daily'];
  return Array.from({ length: 38 }, (_, i) => {
    const year = 1975 + Math.floor(i / 6) * 8, id = entryId(i + 1);
    return { id, revision: 0, contextRevision: 1, kind: 'fact', text: `Synthetic moment ${i + 1}`, actor: 'Synthetic correspondent',
      reviewState: 'candidate', assertionState: 'unknown', confirmationCurrent: false, sourceDate: '2025-01-02T12:00:00Z', eventDate: '', eventDatePrecision: 'unknown',
      source: { system: 'document', id: `source-${i}`, sourceSha256: digest(body), findingId: digest(String(i)) },
      timeline: { legacyId: `moment-${i + 1}`, legacyIds: [`old-${i + 1}`], title: `Synthetic ${categories[i % 6]} moment ${i + 1}`, description: body,
        category: categories[i % 6], date: i === 36 ? null : String(year), precision: i === 36 ? 'unknown' : 'year',
        ...(i % 3 === 0 ? { endDate: String(year + 3), endPrecision: 'year' } : {}),
        ...(i === 1 ? { confirmationBasis: 'owner-tentative', reviewState: 'hypothesis', ageStartWindow: { start: `${year - 1}-09-03`, end: `${year}-09-03` } } : {}),
        ...(i === 37 ? { occurrenceStatus: 'planned' } : { occurrenceStatus: 'reported' }),
        metadata: { subject: i === 35 ? 'thirdparty' : 'owner' }, sourceIds: ['source'], claimsWithExactQuotes: [{ sourceId: 'source', quote: body }] },
      context: { ownerEdits: [], sources: [{ id: 'source', kind: 'document', subject: 'Synthetic lease', bodySha256: digest(body), nativePath: '/Synthetic/lease.pdf', contentSha256: digest('synthetic pdf') }],
        relations: i === 0 ? [{ id: 'source-comparison', title: 'Two dates to compare', kind: 'conflict', eventIds: ['moment-1'], sourceIndependence: 'not-established', claimsWithExactQuotes: [{ sourceId: 'source', quote: body }] }] : [],
        media: i < 4 ? [{ id: `library-${i}`, date: i === 3 ? null : `${year}-06-12`, datePrecision: i === 3 ? 'unknown' : 'day', caption: `Synthetic photo ${i}`,
          ...(i === 3 ? { originalPath: '/Synthetic/photos/undated.svg', sourceContentSha256: digest('synthetic photo') } : { provenance: { system: 'agentx.photos', assetId: assetId(i) } }),
          candidateEventIds: i === 2 ? [] : [id], associationBasis: 'Synthetic explicit proposed binding.' }] : [] } };
  });
}

function createFixture() {
  const entries = fixtureEntries(), writes = [];
  const send = (res, data, code = 200, photos = false) => { res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });res.end(JSON.stringify(photos ? { ok: code === 200, data } : { status: code === 200 ? 'success' : 'error', data, message: code === 409 ? 'Context changed' : undefined })); };
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://fixture');
    try {
      if (req.method === 'GET' && url.pathname === '/api/secretary/history/timeline') return send(res, { entries, total: entries.length, readAt: '2026-01-01T12:00:00Z',
        displayPreferences: { storyThreads: Array.from({ length: 6 }, (_, i) => ({ id: `subject-${i}`, label: `Chosen subject ${i + 1}`, eventIds: [`moment-${i + 1}`], queries: [] })) } });
      if (url.pathname === '/api/secretary/desk') return send(res, { mail: { catchup: { objectiveReviews: [
        { objectiveId: 'life-timeline', version: 'v1', phase: 'done', counts: { sourcesTextReviewed: 999 } },
        { objectiveId: 'life-timeline', version: 'v2', phase: 'running', counts: { sourcesTextReviewed: 4, sourcesTextCovered: 12, equivalentPages: 8, targetSources: 20, reviewedPages: 6 } }],
      archiveProgress: { reviewedPages: 22, pendingTextPages: 30 }, limits: ['Synthetic scoped coverage.'] } } });
      if (url.pathname === '/api/photos/count') return send(res, { total: 42, exact: true }, 200, true);
      if (url.pathname === '/api/photos/search') { const next = url.searchParams.has('cursor');return send(res, { items: [next ? 2 : 0, ...(next ? [] : [1])].map(i => ({ id: assetId(i), type: 'image', fileName: `synthetic-${i}.svg`,
        takenAt: '2001-06-12T12:00:00Z', city: 'Synthetic city', description: 'A synthetic landscape.', thumbnail: `/api/photos/assets/${assetId(i)}/thumbnail` })), nextCursor: next ? null : 'second' }, 200, true); }
      if (/^\/api\/photos\/assets\/[^/]+\/thumbnail$/.test(url.pathname) || url.pathname === '/api/secretary/files/content') { res.writeHead(200, { 'Content-Type': 'image/svg+xml' });return res.end('<svg xmlns="http://www.w3.org/2000/svg" width="800" height="500"><rect width="800" height="500" fill="#244d58"/><circle cx="600" cy="100" r="55" fill="#d9bd79"/><path d="M0 500 300 140 620 500" fill="#608a74"/></svg>'); }
      if (/^\/api\/secretary\/history\/[^/]+\/sources\/source$/.test(url.pathname)) return send(res, { source: { id: 'source', kind: 'document', subject: 'Synthetic lease', body, bodySha256: digest(body), nativePath: '/Synthetic/lease.pdf', contentSha256: digest('synthetic pdf') } });
      if (url.pathname === '/api/secretary/files/read') return send(res, { kind: 'document', type: 'pdf', bytes: 100, url: '/api/secretary/files/content?synthetic=1' });
      if (req.method === 'POST') {
        const chunks = [];for await (const chunk of req) chunks.push(chunk);
        const input = JSON.parse(Buffer.concat(chunks).toString());writes.push({ path: url.pathname, input });
        const match = /^\/api\/secretary\/history\/([^/]+)\/(review|context|souvenir)$/.exec(url.pathname);
        const entry = entries.find(e => e.id === match?.[1]);if (!entry) return send(res, {}, 404);
        if (match[2] === 'context') { if (input.revision !== entry.contextRevision) return send(res, {}, 409);Object.assign(entry.timeline, input.changes.timeline);entry.contextRevision++;entry.context.ownerEdits.push({});entry.confirmationCurrent = false;if (entry.assertionState === 'confirmed') { entry.recordedAssertionState = 'confirmed';entry.assertionState = 'unknown'; }return send(res, { entry }); }
        if (input.revision !== entry.revision || input.assertionState === 'confirmed' && input.contextRevision !== entry.contextRevision) return send(res, {}, 409);
        if (match[2] === 'review') { entry.revision++;entry.reviewState = input.state;if (input.assertionState) { entry.assertionState = input.assertionState;entry.confirmationCurrent = true; }return send(res, { entry }); }
        return send(res, {}, 400); // The journey deliberately never keeps a souvenir.
      }
      if (url.pathname.startsWith('/atlas/')) {
        const rel = decodeURIComponent(url.pathname.slice(7)) || 'index.html', file = path.resolve(root, rel);
        if (!file.startsWith(root + path.sep)) return send(res, {}, 404);
        const bytes = await fs.readFile(file);res.writeHead(200, { 'Content-Type': ({ '.js': 'text/javascript', '.css': 'text/css', '.html': 'text/html', '.woff2': 'font/woff2' })[path.extname(file)] || 'application/octet-stream' });return res.end(bytes);
      }
      return send(res, {}, 404);
    } catch (error) { send(res, { error: error.message }, 500); }
  });
  return { server, entries, writes };
}
if (require.main === module) { const { server } = createFixture();server.listen(Number(process.env.ATLAS_FIXTURE_PORT || 4192), '127.0.0.1', () => console.log('Synthetic Atlas fixture ready')); }
module.exports = { createFixture, fixtureEntries };
