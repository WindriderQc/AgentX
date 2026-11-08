'use strict';

// Only synthetic metadata: no Immich instance, filesystem photo or inference.
const express = require('express');
const request = require('supertest');
const { createPhotoRoutes } = require('../../routes/photos');
const { createPhotoService } = require('../../src/services/photos/photoService');
const { handleMcpMessage } = require('../../src/services/mcpSkillBus');

const ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const ORIGINAL = '2004-02-29T12:34:56.000-05:00';
const LOCAL = '2005-03-01T09:10:11';
const FILE = '2026-11-01T12:00:00.000Z';
const dates = (takenAt = null, takenAtSource = null, dateTimeOriginal = null) => ({ takenAt, takenAtSource, dateTimeOriginal });

function setup(fields = {}) {
  const state = { record: { id: ID, type: 'IMAGE', visibility: 'timeline', originalFileName: 'synthetic-scan.jpg', ...fields } };
  const calls = [];
  const service = createPhotoService({ client: { json: async route => {
    calls.push(route);
    if (route === '/tags' || route.endsWith('/ocr')) return [];
    if (route.startsWith('/search/')) return { assets: { items: [state.record] } };
    if (route === `/assets/${ID}`) return state.record;
    throw new Error(`Unexpected upstream read: ${route}`);
  } } });
  const app = express();
  app.use('/api/photos', createPhotoRoutes({ service }));
  return { state, service, app, calls };
}

describe('photo date provenance in API and tools', () => {
  test.each([
    ['EXIF has priority', { exifInfo: { dateTimeOriginal: ORIGINAL }, localDateTime: LOCAL, fileCreatedAt: FILE },
      dates(ORIGINAL, 'exifInfo.dateTimeOriginal', ORIGINAL)],
    ['local time stays attributed to Immich', { localDateTime: LOCAL, fileCreatedAt: FILE }, dates(LOCAL, 'localDateTime')],
    ['a file date never fills the original EXIF date', { fileCreatedAt: FILE }, dates(FILE, 'fileCreatedAt')],
    ['missing dates', {}, dates()],
    ['mtime and file modification are not capture evidence', { mtime: 1700000000, fileModifiedAt: FILE }, dates()],
    ['invalid original with valid file fallback', { exifInfo: { dateTimeOriginal: '2001-02-29T12:00:00Z' }, fileCreatedAt: FILE },
      dates(FILE, 'fileCreatedAt')],
    ['invalid local time with valid file fallback', { localDateTime: '2025-04-31T12:00:00Z', fileCreatedAt: FILE },
      dates(FILE, 'fileCreatedAt')],
    ['malformed dates', { exifInfo: { dateTimeOriginal: { date: ORIGINAL } }, localDateTime: 'yesterday', fileCreatedAt: 1700000000 }, dates()],
    ['partial date has no invented day', { exifInfo: { dateTimeOriginal: '2004' }, localDateTime: '2005-03' }, dates()],
    ['invalid time and offset', { exifInfo: { dateTimeOriginal: '2004-02-29T24:00:00Z' },
      localDateTime: '2004-02-29T12:60:00Z', fileCreatedAt: '2004-02-29T12:00:00+99:00' }, dates()],
    ['invalid month and day', { exifInfo: { dateTimeOriginal: '2004-00-01' }, localDateTime: '2004-13-01', fileCreatedAt: '2004-03-00' }, dates()],
    ['invalid second, offset minute and overlong value', { exifInfo: { dateTimeOriginal: '2004-02-29T12:00:60Z' },
      localDateTime: '2004-02-29T12:00:00+01:60', fileCreatedAt: FILE + ' '.repeat(41) }, dates()],
    ['day-only metadata stays day-only', { exifInfo: { dateTimeOriginal: '2004-02-29' } },
      dates('2004-02-29', 'exifInfo.dateTimeOriginal', '2004-02-29')],
    ['century leap rule', { exifInfo: { dateTimeOriginal: '1900-02-29' } }, dates()],
    ['no time zone is supplied', { exifInfo: { dateTimeOriginal: LOCAL } }, dates(LOCAL, 'exifInfo.dateTimeOriginal', LOCAL)],
  ])('%s: exact search, smart search and details agree for owner and family', async (_name, fields, expected) => {
    const { app, calls } = setup(fields);
    for (const audience of ['owner', 'family']) {
      for (const [route, upstream] of [
        ['/search', ['/search/metadata', ...(audience === 'family' ? ['/tags'] : [])]],
        ['/search/smart?q=synthetic', ['/search/smart', '/search/metadata']],
        [`/assets/${ID}`, [`/assets/${ID}`, `/assets/${ID}/ocr`]],
      ]) {
        const start = calls.length;
        const result = await request(app).get(`/api/photos${route}`).query({ audience }).expect(200);
        const photo = result.body.data.items?.[0] || result.body.data;
        expect(photo).toMatchObject(expected);
        expect(calls.slice(start)).toEqual(upstream);
      }
    }
  });

  test('erasing upstream dates clears provenance and original date in the API and MCP result', async () => {
    const { app, state, service } = setup({ exifInfo: { dateTimeOriginal: ORIGINAL }, fileCreatedAt: FILE });
    const call = (name, args) => handleMcpMessage({ jsonrpc: '2.0', id: 1,
      method: 'tools/call', params: { name, arguments: args } }, { photoService: service });
    const original = await call('photo_details', { id: ID, audience: 'family' });
    expect(original.result.structuredContent).toMatchObject(dates(ORIGINAL, 'exifInfo.dateTimeOriginal', ORIGINAL));

    delete state.record.exifInfo;
    const fallback = await call('photo_search', { audience: 'family' });
    expect(fallback.result.structuredContent.items[0]).toMatchObject(dates(FILE, 'fileCreatedAt'));
    expect(JSON.parse(fallback.result.content[0].text).items[0]).toMatchObject(dates(FILE, 'fileCreatedAt'));

    delete state.record.fileCreatedAt;
    const unknown = await request(app).get(`/api/photos/assets/${ID}`).expect(200);
    expect(unknown.body.data).toMatchObject(dates());
    const smart = await call('photo_search', { query: 'synthetic', audience: 'family' });
    expect(smart.result.structuredContent.items[0]).toMatchObject(dates());
    const details = await call('photo_details', { id: ID });
    expect(details.result.structuredContent).toMatchObject(dates());
    expect(JSON.stringify(details)).not.toContain(ORIGINAL);
    expect(JSON.stringify(smart)).not.toContain(FILE);
  });

  test('upstream failure is an error rather than a fabricated unknown-date photo', async () => {
    const error = Object.assign(new Error('Synthetic Immich unavailable'), { status: 502, code: 'PHOTOS_UPSTREAM_ERROR' });
    const service = createPhotoService({ client: { json: async () => { throw error; } } });
    const app = express();
    app.use('/api/photos', createPhotoRoutes({ service }));
    const result = await request(app).get('/api/photos/search').expect(502);
    expect(result.body.code).toBe('PHOTOS_UPSTREAM_ERROR');
    expect(result.body.data).toBeUndefined();
  });
});
