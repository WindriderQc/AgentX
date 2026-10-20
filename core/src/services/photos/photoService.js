'use strict';

// Compact, bounded photo questions over Immich for agents and pages. Every
// answer is small JSON; images go through Core's thumbnail proxy.

const { createImmichClient, photoError } = require('./immichClient');

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 50;
const MAX_QUERY = 300;
const MAX_FILTER_TEXT = 120;
const MAX_PEOPLE_FILTER = 5;
const MAX_DESCRIPTION = 2000;
const SUMMARY_DESCRIPTION = 200;
const MAX_OCR_TEXT = 2000;
const MAX_PEOPLE = 500;
const MAX_COUNTED_PEOPLE = 100;
const COUNT_CONCURRENCY = 4;
const PEOPLE_CACHE_MS = 5 * 60 * 1000;
const IMAGE_SIZES = Object.freeze(['thumbnail', 'preview']);

function bad(message) {
  return photoError(400, 'PHOTOS_BAD_REQUEST', message);
}

function text(value, max, name) {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value !== 'string') throw bad(`${name} must be text`);
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  if (trimmed.length > max) throw bad(`${name} is longer than ${max} characters`);
  return trimmed;
}

function assetId(value, name = 'id') {
  const id = String(value || '').trim();
  if (!UUID.test(id)) throw bad(`${name} must be an Immich id`);
  return id.toLowerCase();
}

function limitOf(value) {
  if (value === undefined || value === '') return DEFAULT_LIMIT;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed < 1) throw bad('limit must be a positive number');
  return Math.min(MAX_LIMIT, parsed);
}

function list(value) {
  if (value === undefined || value === null || value === '') return [];
  const items = (Array.isArray(value) ? value : String(value).split(','))
    .map((item) => String(item).trim()).filter(Boolean);
  if (items.length > MAX_PEOPLE_FILTER) throw bad(`at most ${MAX_PEOPLE_FILTER} people per question`);
  return items;
}

// "2025", "2025-07", "2025-07-14" or a full ISO time. `from` is inclusive;
// a partial `to` covers its whole year, month or day.
function dateBound(value, edge) {
  const raw = text(value, 40, edge);
  if (!raw) return undefined;
  const partial = raw.match(/^(\d{4})(?:-(\d{2}))?(?:-(\d{2}))?$/);
  if (partial) {
    const [, y, m, d] = partial;
    const year = Number(y); const month = m ? Number(m) - 1 : 0; const day = d ? Number(d) : 1;
    const start = new Date(Date.UTC(year, month, day));
    if (Number.isNaN(start.getTime()) || start.getUTCMonth() !== month || start.getUTCDate() !== day) {
      throw bad(`${edge} is not a valid date`);
    }
    if (edge === 'from') return { gte: start.toISOString() };
    const end = d ? new Date(Date.UTC(year, month, day + 1))
      : m ? new Date(Date.UTC(year, month + 1, 1)) : new Date(Date.UTC(year + 1, 0, 1));
    return { lt: end.toISOString() };
  }
  const parsed = new Date(raw);
  if (Number.isNaN(parsed.getTime())) throw bad(`${edge} is not a valid date`);
  return edge === 'from' ? { gte: parsed.toISOString() } : { lte: parsed.toISOString() };
}

function fold(value) {
  return String(value || '').normalize('NFD').replace(/[̀-ͯ]/g, '').trim().toLowerCase();
}

function thumbnailPath(id, size = 'thumbnail') {
  return `/api/photos/assets/${id}/thumbnail${size === 'thumbnail' ? '' : `?size=${size}`}`;
}

function clip(value, max) {
  const textValue = typeof value === 'string' ? value.trim() : '';
  if (!textValue) return null;
  return textValue.length > max ? `${textValue.slice(0, max - 1)}…` : textValue;
}

function takenAt(asset) {
  return asset?.exifInfo?.dateTimeOriginal || asset?.localDateTime || asset?.fileCreatedAt || null;
}

function namedPeople(asset) {
  return (Array.isArray(asset?.people) ? asset.people : [])
    .filter((person) => person && !person.isHidden)
    .map((person) => ({ id: person.id, name: person.name || null }));
}

function summarize(asset) {
  const exif = asset.exifInfo || {};
  return {
    id: asset.id,
    type: asset.type ? String(asset.type).toLowerCase() : null,
    takenAt: takenAt(asset),
    fileName: asset.originalFileName || null,
    city: exif.city || null,
    country: exif.country || null,
    people: namedPeople(asset).map((person) => person.name).filter(Boolean),
    description: clip(exif.description, SUMMARY_DESCRIPTION),
    thumbnail: thumbnailPath(asset.id),
  };
}

function ocrText(lines) {
  if (!Array.isArray(lines) || !lines.length) return null;
  const ordered = lines
    .filter((line) => line && typeof line.text === 'string' && line.text.trim())
    .sort((a, b) => (Number(a.y1) - Number(b.y1)) || (Number(a.x1) - Number(b.x1)));
  return clip(ordered.map((line) => line.text.trim()).join('\n'), MAX_OCR_TEXT);
}

async function mapLimited(items, size, fn) {
  const results = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(size, items.length) }, async () => {
    while (next < items.length) {
      const index = next; next += 1;
      results[index] = await fn(items[index], index);
    }
  });
  await Promise.all(workers);
  return results;
}

function createPhotoService({ client = createImmichClient(), now = () => Date.now() } = {}) {
  let peopleCache = null;

  async function allPeople() {
    if (peopleCache && now() - peopleCache.at < PEOPLE_CACHE_MS) return peopleCache.people;
    const answer = await client.json(`/people?size=${MAX_PEOPLE}&withHidden=false`);
    const people = (Array.isArray(answer?.people) ? answer.people : [])
      .filter((person) => person && UUID.test(String(person.id)) && !person.isHidden)
      .map((person) => ({ id: String(person.id).toLowerCase(), name: String(person.name || '').trim() }));
    peopleCache = { at: now(), people, total: Number(answer?.total) || people.length };
    return people;
  }

  // Names or ids → ids. An unknown name is an error, never a silent drop: a
  // dropped filter would answer a different question.
  async function resolvePeople(names, ids) {
    const resolved = ids.map((id) => assetId(id, 'personId'));
    if (names.length) {
      const people = await allPeople();
      for (const name of names) {
        const wanted = fold(name);
        const matches = people.filter((person) => person.name && fold(person.name) === wanted);
        if (!matches.length) {
          throw photoError(404, 'PHOTOS_PERSON_UNKNOWN', `No named person "${name.slice(0, 60)}"; list people with GET /api/photos/people`);
        }
        resolved.push(...matches.map((person) => person.id));
      }
    }
    return [...new Set(resolved)];
  }

  async function buildFilter(query) {
    const filter = {};
    const personIds = await resolvePeople(list(query.person), list(query.personId));
    if (personIds.length) filter.personIds = { all: personIds };
    const city = text(query.city, MAX_FILTER_TEXT, 'city');
    if (city) filter.city = { eq: city };
    const country = text(query.country, MAX_FILTER_TEXT, 'country');
    if (country) filter.country = { eq: country };
    const year = text(query.year, 4, 'year');
    if (year && !/^\d{4}$/.test(year)) throw bad('year must have four digits');
    const from = dateBound(query.from ?? year, 'from');
    const to = dateBound(query.to ?? year, 'to');
    if (from || to) filter.takenAt = { ...from, ...to };
    return { filter, personIds };
  }

  function page(answer, limit) {
    const assets = answer?.assets || {};
    const items = (Array.isArray(assets.items) ? assets.items : []).slice(0, limit).map(summarize);
    return { count: items.length, items, nextCursor: assets.nextCursor || null };
  }

  const service = {
    status() {
      const settings = client.settings();
      return { enabled: settings.enabled, descriptionWriteEnabled: settings.enabled && settings.descriptionWriteEnabled };
    },

    async smartSearch(query = {}) {
      const q = text(query.q ?? query.query, MAX_QUERY, 'q');
      if (!q) throw bad('q is required: describe the photo in words');
      const limit = limitOf(query.limit);
      const { filter } = await buildFilter(query);
      const language = text(query.language, 10, 'language');
      const answer = await client.json('/search/smart', {
        method: 'POST',
        body: { query: q, size: limit, withExif: true, ...(language ? { language } : {}), ...(Object.keys(filter).length ? { filter } : {}) },
      });
      const result = page(answer, limit);
      // Smart search ranks by likeness and always returns its best matches:
      // it has no "nothing matched" answer and no further page here.
      return { query: q, ranked: true, count: result.count, items: result.items };
    },

    async metadataSearch(query = {}) {
      const limit = limitOf(query.limit);
      const { filter } = await buildFilter(query);
      const description = text(query.text, MAX_FILTER_TEXT, 'text');
      if (description) filter.description = { like: description };
      const ocr = text(query.ocr, MAX_FILTER_TEXT, 'ocr');
      if (ocr) filter.ocr = { matches: ocr };
      const fileName = text(query.fileName, MAX_FILTER_TEXT, 'fileName');
      if (fileName) filter.originalFileName = { like: fileName };
      if (query.favorite === 'true' || query.favorite === true) filter.isFavorite = { eq: true };
      const cursor = text(query.cursor, 500, 'cursor');
      const order = query.order === undefined || query.order === '' ? 'desc' : String(query.order);
      if (!['asc', 'desc'].includes(order)) throw bad('order must be asc or desc');
      const answer = await client.json('/search/metadata', {
        method: 'POST',
        body: {
          size: limit, withExif: true, withPeople: true, orderBy: { direction: order },
          ...(Object.keys(filter).length ? { filter } : {}), ...(cursor ? { cursor } : {}),
        },
      });
      return page(answer, limit);
    },

    async people(query = {}) {
      const people = await allPeople();
      const includeUnnamed = query.includeUnnamed === 'true' || query.includeUnnamed === true;
      const shown = (includeUnnamed ? people : people.filter((person) => person.name))
        .map((person) => ({ id: person.id, name: person.name || null }));
      const result = { count: shown.length, unnamed: people.filter((person) => !person.name).length, people: shown };
      if (!(query.counts === 'true' || query.counts === true)) return result;
      // Photo counts need the key's person.statistics permission; without it
      // the list still answers and says why the counts are missing.
      let countsAvailable = true;
      await mapLimited(shown.slice(0, MAX_COUNTED_PEOPLE), COUNT_CONCURRENCY, async (person) => {
        if (!countsAvailable) { person.photoCount = null; return; }
        try {
          const stats = await client.json(`/people/${person.id}/statistics`);
          person.photoCount = Number.isInteger(stats?.assets) ? stats.assets : null;
        } catch (error) {
          if (error.code !== 'PHOTOS_UPSTREAM_FORBIDDEN') throw error;
          countsAvailable = false; person.photoCount = null;
        }
      });
      for (const person of shown.slice(MAX_COUNTED_PEOPLE)) person.photoCount = null;
      result.countsAvailable = countsAvailable;
      if (!countsAvailable) result.countsUnavailableReason = 'The Immich key lacks person.statistics';
      return result;
    },

    async personAssets(id, query = {}) {
      return service.metadataSearch({ ...query, person: undefined, personId: assetId(id, 'personId') });
    },

    async asset(id) {
      const safeId = assetId(id);
      const asset = await client.json(`/assets/${safeId}`);
      let ocr = null;
      try { ocr = ocrText(await client.json(`/assets/${safeId}/ocr`)); } catch (error) {
        if (!['PHOTOS_NOT_FOUND', 'PHOTOS_UPSTREAM_FORBIDDEN'].includes(error.code)) throw error;
      }
      const exif = asset?.exifInfo || {};
      const coordinates = Number.isFinite(exif.latitude) && Number.isFinite(exif.longitude)
        ? { latitude: Number(exif.latitude.toFixed(5)), longitude: Number(exif.longitude.toFixed(5)) } : null;
      return {
        id: safeId,
        type: asset?.type ? String(asset.type).toLowerCase() : null,
        takenAt: takenAt(asset),
        timeZone: exif.timeZone || null,
        fileName: asset?.originalFileName || null,
        place: { city: exif.city || null, state: exif.state || null, country: exif.country || null, coordinates },
        people: namedPeople(asset),
        description: clip(exif.description, MAX_DESCRIPTION),
        ocrText: ocr,
        camera: [exif.make, exif.model].filter(Boolean).join(' ') || null,
        width: asset?.width ?? exif.exifImageWidth ?? null,
        height: asset?.height ?? exif.exifImageHeight ?? null,
        favorite: Boolean(asset?.isFavorite),
        thumbnail: thumbnailPath(safeId),
        preview: thumbnailPath(safeId, 'preview'),
      };
    },

    async thumbnail(id, size = 'thumbnail') {
      const safeId = assetId(id);
      const wanted = size === undefined || size === '' ? 'thumbnail' : String(size);
      if (!IMAGE_SIZES.includes(wanted)) throw bad('size must be thumbnail or preview');
      return client.image(`/assets/${safeId}/thumbnail?size=${wanted}`);
    },

    async setDescription(id, description) {
      const settings = client.settings();
      if (!settings.enabled) throw photoError(503, 'PHOTOS_NOT_CONFIGURED', 'Photos are not configured on this instance');
      if (!settings.descriptionWriteEnabled) {
        throw photoError(403, 'PHOTOS_WRITE_DISABLED', 'Writing photo descriptions is off on this instance');
      }
      const safeId = assetId(id);
      if (typeof description !== 'string') throw bad('description must be text');
      const value = description.trim();
      if (value.length > MAX_DESCRIPTION) throw bad(`description is longer than ${MAX_DESCRIPTION} characters`);
      await client.json(`/assets/${safeId}`, { method: 'PUT', body: { description: value } });
      return service.asset(safeId);
    },
  };
  return service;
}

module.exports = { createPhotoService, dateBound, summarize, ocrText, MAX_LIMIT };
