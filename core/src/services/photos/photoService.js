'use strict';

// Compact, bounded photo questions over Immich for agents and pages. Every
// answer is small JSON; images go through Core's thumbnail proxy.
//
// Audience: `owner` (default) sees everything Immich shows. `family` (the
// children's and family surfaces) sees only timeline photos (not archived,
// hidden or locked), and never a generated description or AgentX tag that
// the owner has not reviewed yet (tag AgentX/Relecture/à relire).

const { createImmichClient, photoError } = require('./immichClient');
const {
  UUID, MAX_FILTER_TEXT, bad, text, immichId, names, fold, matchName, dateBound, personBranches,
} = require('./photoFilters');

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 50;
const MAX_QUERY = 300;
const MAX_DESCRIPTION = 2000;
const SUMMARY_DESCRIPTION = 200;
const MAX_OCR_TEXT = 2000;
const MAX_PEOPLE = 500;
const MAX_TAGS = 1000;
const MAX_COUNTED_PEOPLE = 100;
const COUNT_CONCURRENCY = 4;
const COUNT_PAGE = 1000;
const MAX_COUNT_PAGES = 10;
const CACHE_MS = 5 * 60 * 1000;
const IMAGE_SIZES = Object.freeze(['thumbnail', 'preview']);
const AUDIENCES = Object.freeze(['owner', 'family']);
const REVIEW_PENDING_TAG = 'AgentX/Relecture/à relire';
const INTERNAL_TAG_PREFIXES = Object.freeze(['agentx/relecture', 'agentx/a verifier']);
const PLACE_FIELDS = Object.freeze({ city: 'city', state: 'state', country: 'country' });

function limitOf(value) {
  if (value === undefined || value === '') return DEFAULT_LIMIT;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed < 1) throw bad('limit must be a positive number');
  return Math.min(MAX_LIMIT, parsed);
}

function audienceOf(value) {
  const audience = value === undefined || value === '' ? 'owner' : String(value);
  if (!AUDIENCES.includes(audience)) throw bad('audience must be owner or family');
  return audience;
}

function flag(value) {
  return value === true || value === 'true';
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

function visiblePeople(people) {
  return (Array.isArray(people) ? people : [])
    .filter((person) => person && !person.isHidden)
    .map((person) => ({ id: person.id, name: person.name || null }));
}

function isInternalTag(value) {
  const folded = fold(value);
  return INTERNAL_TAG_PREFIXES.some((prefix) => folded === prefix || folded.startsWith(`${prefix}/`));
}

function ocrText(lines) {
  if (!Array.isArray(lines) || !lines.length) return null;
  const ordered = lines
    .filter((line) => line && typeof line.text === 'string' && line.text.trim())
    .sort((a, b) => (Number(a.y1) - Number(b.y1)) || (Number(a.x1) - Number(b.x1)));
  return clip(ordered.map((line) => line.text.trim()).join('\n'), MAX_OCR_TEXT);
}

async function mapLimited(items, size, fn) {
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(size, items.length) }, async () => {
    while (next < items.length) { const index = next; next += 1; await fn(items[index], index); }
  }));
}

function createPhotoService({ client = createImmichClient(), now = () => Date.now(), timeZone } = {}) {
  const caches = new Map();
  async function cached(key, load) {
    const hit = caches.get(key);
    if (hit && now() - hit.at < CACHE_MS) return hit.value;
    const value = await load();
    caches.set(key, { at: now(), value });
    return value;
  }

  const allPeople = () => cached('people', async () => {
    const answer = await client.json(`/people?size=${MAX_PEOPLE}&withHidden=false`);
    return (Array.isArray(answer?.people) ? answer.people : [])
      .filter((person) => person && UUID.test(String(person.id)) && !person.isHidden)
      .map((person) => ({ id: String(person.id).toLowerCase(), name: String(person.name || '').trim() }));
  });

  const allTags = () => cached('tags', async () => {
    const answer = await client.json('/tags');
    return (Array.isArray(answer) ? answer : []).slice(0, MAX_TAGS)
      .filter((tag) => tag && UUID.test(String(tag.id)) && typeof tag.value === 'string')
      .map((tag) => ({ id: String(tag.id).toLowerCase(), value: tag.value, name: tag.name || tag.value }));
  });

  const knownPlaces = (field) => cached(`place:${field}`, async () => {
    const answer = await client.json(`/search/suggestions?type=${field}`);
    return (Array.isArray(answer) ? answer : []).filter((value) => typeof value === 'string' && value.trim());
  });

  // Each asked person → all the face groups carrying that name.
  async function personGroups(query) {
    const groups = names(query.personId, 'personId').map((id) => [immichId(id, 'personId')]);
    const asked = names(query.person, 'person');
    if (asked.length) {
      const people = (await allPeople()).filter((person) => person.name);
      const known = [...new Set(people.map((person) => person.name))];
      for (const name of asked) {
        const matched = new Set(matchName(name, known, {
          kind: 'named person', unknownCode: 'PHOTOS_PERSON_UNKNOWN', ambiguousCode: 'PHOTOS_PERSON_AMBIGUOUS',
          hint: 'list people with GET /api/photos/people',
        }).map(fold));
        groups.push(people.filter((person) => matched.has(fold(person.name))).map((person) => person.id));
      }
    }
    return groups;
  }

  async function tagIds(query) {
    const asked = names(query.tag, 'tag');
    if (!asked.length) return [];
    const tags = await allTags();
    const ids = [];
    for (const wanted of asked) {
      // A full path ("AgentX/Saison/été") or its last part ("été").
      const byValue = tags.filter((tag) => fold(tag.value) === fold(wanted));
      const matched = byValue.length ? byValue : (() => {
        const values = matchName(wanted, [...new Set(tags.map((tag) => tag.name))], {
          kind: 'tag', unknownCode: 'PHOTOS_TAG_UNKNOWN', ambiguousCode: 'PHOTOS_TAG_AMBIGUOUS',
          hint: 'list tags with GET /api/photos/tags',
        }).map(fold);
        const hits = tags.filter((tag) => values.includes(fold(tag.name)));
        if (new Set(hits.map((tag) => tag.value)).size > 1) {
          throw Object.assign(photoError(409, 'PHOTOS_TAG_AMBIGUOUS', `"${wanted.slice(0, 60)}" is several tags; give the full path`),
            { details: { candidates: hits.map((tag) => tag.value).slice(0, 8) } });
        }
        return hits;
      })();
      ids.push(matched[0].id);
    }
    return [...new Set(ids)];
  }

  async function placeFilter(query, filter, notes) {
    for (const [param, field] of Object.entries(PLACE_FIELDS)) {
      const wanted = text(query[param], MAX_FILTER_TEXT, param);
      if (!wanted) continue;
      const matched = matchName(wanted, await knownPlaces(field), {
        kind: param, unknownCode: 'PHOTOS_PLACE_UNKNOWN', ambiguousCode: 'PHOTOS_PLACE_AMBIGUOUS',
        hint: 'only places Immich found from GPS can be searched',
      });
      filter[field] = matched.length === 1 ? { eq: matched[0] } : { in: [...new Set(matched)] };
      if (field === 'city') {
        const states = (await knownPlaces('state')).filter((state) => matched.some((city) => fold(city) === fold(state)));
        if (states.length) notes.push(`"${matched[0]}" is also a state or province; use state=${states[0]} for the whole region.`);
      }
    }
  }

  async function buildFilter(query, audience, { metadata = false, notes = [] } = {}) {
    const filter = {};
    const groups = await personGroups(query);
    if (groups.length && groups.every((ids) => ids.length === 1)) {
      filter.personIds = { all: groups.map((ids) => ids[0]) };
    } else if (groups.length) {
      filter.or = personBranches(groups).map((combo) => ({ personIds: { all: combo } }));
    }
    await placeFilter(query, filter, notes);
    const tags = await tagIds(query);
    if (tags.length) filter.tagIds = { all: tags };
    const year = text(query.year, 4, 'year');
    if (year && !/^\d{4}$/.test(year)) throw bad('year must have four digits');
    const from = dateBound(query.from ?? year, 'from', timeZone);
    const to = dateBound(query.to ?? year, 'to', timeZone);
    if (from || to) filter.takenAt = { ...from, ...to };
    if (metadata) {
      const description = text(query.text, MAX_FILTER_TEXT, 'text');
      if (description) filter.description = { like: description };
      const ocr = text(query.ocr, MAX_FILTER_TEXT, 'ocr');
      if (ocr) filter.ocr = { matches: ocr };
      const fileName = text(query.fileName, MAX_FILTER_TEXT, 'fileName');
      if (fileName) filter.originalFileName = { like: fileName };
      if (flag(query.favorite)) filter.isFavorite = { eq: true };
    }
    if (audience === 'family') filter.visibility = { eq: 'timeline' };
    return filter;
  }

  const withFilter = (filter) => (Object.keys(filter).length ? { filter } : {});

  // Ids among `ids` whose card waits for the owner's review.
  async function pendingReview(ids) {
    if (!ids.length) return new Set();
    const pending = (await allTags()).find((tag) => fold(tag.value) === fold(REVIEW_PENDING_TAG));
    if (!pending) return new Set();
    const answer = await client.json('/search/metadata', { method: 'POST', body: {
      size: ids.length, filter: { tagIds: { all: [pending.id] }, or: ids.map((id) => ({ id: { eq: id } })) },
    } });
    return new Set((answer?.assets?.items || []).map((asset) => String(asset.id).toLowerCase()));
  }

  // Smart search answers carry no people; one metadata call fetches them.
  async function peopleOf(ids) {
    if (!ids.length) return new Map();
    const answer = await client.json('/search/metadata', { method: 'POST', body: {
      size: ids.length, withPeople: true, filter: { or: ids.map((id) => ({ id: { eq: id } })) },
    } });
    return new Map((answer?.assets?.items || []).map((asset) => [String(asset.id).toLowerCase(), visiblePeople(asset.people)]));
  }

  async function summarize(assets, audience, { fillPeople = false } = {}) {
    const ids = assets.map((asset) => String(asset.id).toLowerCase());
    let people = null;
    if (fillPeople) {
      try { people = await peopleOf(ids); } catch { people = null; }
    }
    const hidden = audience === 'family' ? await pendingReview(ids) : new Set();
    return assets.map((asset) => {
      const id = String(asset.id).toLowerCase();
      const exif = asset.exifInfo || {};
      const named = fillPeople ? (people ? (people.get(id) || []) : null) : visiblePeople(asset.people);
      return {
        id,
        type: asset.type ? String(asset.type).toLowerCase() : null,
        takenAt: takenAt(asset),
        fileName: asset.originalFileName || null,
        city: exif.city || null,
        state: exif.state || null,
        country: exif.country || null,
        // null: Core could not read who is in the photo; []: nobody named.
        people: named ? named.map((person) => person.name).filter(Boolean) : null,
        description: hidden.has(id) ? null : clip(exif.description, SUMMARY_DESCRIPTION),
        thumbnail: thumbnailPath(id),
      };
    });
  }

  // Exact count: Immich statistics when the key allows it, else paging the
  // metadata search (bounded; `exact: false` when the bound was reached).
  async function countFor(filter) {
    try {
      const stats = await client.json('/search/statistics', { method: 'POST', body: withFilter(filter) });
      if (Number.isInteger(stats?.total)) return { total: stats.total, exact: true };
    } catch (error) {
      if (error.code !== 'PHOTOS_UPSTREAM_FORBIDDEN') throw error;
    }
    let total = 0; let cursor = null;
    for (let page = 0; page < MAX_COUNT_PAGES; page += 1) {
      // orderBy selects Immich's cursor paging even without a filter.
      const answer = await client.json('/search/metadata', { method: 'POST', body: {
        size: COUNT_PAGE, orderBy: { direction: 'desc' }, ...withFilter(filter), ...(cursor ? { cursor } : {}),
      } });
      const assets = answer?.assets || {};
      const got = Array.isArray(assets.items) ? assets.items.length : 0;
      total += got;
      cursor = assets.nextCursor || null;
      // A full page without a cursor cannot prove it was the last one.
      if (!cursor) return { total, exact: got < COUNT_PAGE };
    }
    return { total, exact: false };
  }

  // A place filter can only match photos that have a place at all.
  async function placeCoverage(filter, audience) {
    if (!filter.city && !filter.state && !filter.country) return undefined;
    return cached(`coverage:${audience}`, async () => {
      const base = audience === 'family' ? { visibility: { eq: 'timeline' } } : {};
      const [all, placed] = await Promise.all([countFor(base), countFor({ ...base, country: { ne: null } })]);
      return { photosWithPlace: placed.total, photos: all.total,
        note: 'Photos without GPS have no place and never match a place filter.' };
    });
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
      const audience = audienceOf(query.audience);
      const notes = [];
      const filter = await buildFilter(query, audience, { notes });
      const language = text(query.language, 10, 'language');
      const answer = await client.json('/search/smart', {
        method: 'POST',
        body: { query: q, size: limit, withExif: true, ...(language ? { language } : {}), ...withFilter(filter) },
      });
      const assets = (answer?.assets?.items || []).slice(0, limit);
      const items = await summarize(assets, audience, { fillPeople: true });
      // Smart search ranks by likeness and always returns its best matches:
      // it has no "nothing matched" answer and no further page here.
      const coverage = await placeCoverage(filter, audience);
      return { query: q, ranked: true, count: items.length, items,
        ...(coverage ? { placeCoverage: coverage } : {}), ...(notes.length ? { notes } : {}) };
    },

    async metadataSearch(query = {}) {
      const limit = limitOf(query.limit);
      const audience = audienceOf(query.audience);
      const notes = [];
      const filter = await buildFilter(query, audience, { metadata: true, notes });
      const cursor = text(query.cursor, 500, 'cursor');
      const order = query.order === undefined || query.order === '' ? 'desc' : String(query.order);
      if (!['asc', 'desc'].includes(order)) throw bad('order must be asc or desc');
      const answer = await client.json('/search/metadata', {
        method: 'POST',
        body: { size: limit, withExif: true, withPeople: true, orderBy: { direction: order }, ...withFilter(filter), ...(cursor ? { cursor } : {}) },
      });
      const assets = (answer?.assets?.items || []).slice(0, limit);
      const items = await summarize(assets, audience);
      const coverage = await placeCoverage(filter, audience);
      return { count: items.length, items, nextCursor: answer?.assets?.nextCursor || null,
        ...(coverage ? { placeCoverage: coverage } : {}), ...(notes.length ? { notes } : {}) };
    },

    async count(query = {}) {
      const audience = audienceOf(query.audience);
      const notes = [];
      const filter = await buildFilter(query, audience, { metadata: true, notes });
      const counted = await countFor(filter);
      const coverage = await placeCoverage(filter, audience);
      return { ...counted, ...(coverage ? { placeCoverage: coverage } : {}), ...(notes.length ? { notes } : {}) };
    },

    async people(query = {}) {
      const people = await allPeople();
      const includeUnnamed = flag(query.includeUnnamed);
      const shown = (includeUnnamed ? people : people.filter((person) => person.name))
        .map((person) => ({ id: person.id, name: person.name || null }));
      const result = { count: shown.length, unnamed: people.filter((person) => !person.name).length, people: shown };
      if (!flag(query.counts)) return result;
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

    async places() {
      const [cities, states, countries] = await Promise.all(Object.values(PLACE_FIELDS).map(knownPlaces));
      return { cities, states, countries };
    },

    async tags(query = {}) {
      const audience = audienceOf(query.audience);
      const tags = (await allTags()).filter((tag) => audience === 'owner' || !isInternalTag(tag.value));
      return { count: tags.length, tags: tags.map((tag) => tag.value).sort((a, b) => a.localeCompare(b, 'fr')) };
    },

    async personAssets(id, query = {}) {
      return service.metadataSearch({ ...query, person: undefined, personId: immichId(id, 'personId') });
    },

    async asset(id, query = {}) {
      const safeId = immichId(id);
      const audience = audienceOf(query.audience);
      const asset = await client.json(`/assets/${safeId}`);
      if (audience === 'family' && asset?.visibility && asset.visibility !== 'timeline') {
        throw photoError(404, 'PHOTOS_NOT_FOUND', 'Immich has no such item');
      }
      let ocr = null;
      try { ocr = ocrText(await client.json(`/assets/${safeId}/ocr`)); } catch (error) {
        if (!['PHOTOS_NOT_FOUND', 'PHOTOS_UPSTREAM_FORBIDDEN'].includes(error.code)) throw error;
      }
      const exif = asset?.exifInfo || {};
      const allTagValues = (Array.isArray(asset?.tags) ? asset.tags : []).map((tag) => tag?.value).filter((value) => typeof value === 'string');
      const reviewPending = allTagValues.some((value) => fold(value) === fold(REVIEW_PENDING_TAG));
      const familyHides = audience === 'family' && reviewPending;
      const tags = allTagValues.filter((value) => audience === 'owner'
        || (!isInternalTag(value) && !(familyHides && fold(value).startsWith('agentx/'))));
      const coordinates = Number.isFinite(exif.latitude) && Number.isFinite(exif.longitude)
        ? { latitude: Number(exif.latitude.toFixed(5)), longitude: Number(exif.longitude.toFixed(5)) } : null;
      return {
        id: safeId,
        type: asset?.type ? String(asset.type).toLowerCase() : null,
        takenAt: takenAt(asset),
        timeZone: exif.timeZone || null,
        fileName: asset?.originalFileName || null,
        place: { city: exif.city || null, state: exif.state || null, country: exif.country || null, coordinates },
        people: visiblePeople(asset?.people),
        description: familyHides ? null : clip(exif.description, MAX_DESCRIPTION),
        reviewPending,
        tags,
        ocrText: ocr,
        camera: [exif.make, exif.model].filter(Boolean).join(' ') || null,
        width: asset?.width ?? exif.exifImageWidth ?? null,
        height: asset?.height ?? exif.exifImageHeight ?? null,
        favorite: Boolean(asset?.isFavorite),
        thumbnail: thumbnailPath(safeId),
        preview: thumbnailPath(safeId, 'preview'),
      };
    },

    async thumbnail(id, size = 'thumbnail', query = {}) {
      const safeId = immichId(id);
      const wanted = size === undefined || size === '' ? 'thumbnail' : String(size);
      if (!IMAGE_SIZES.includes(wanted)) throw bad('size must be thumbnail or preview');
      if (audienceOf(query.audience) === 'family') {
        const asset = await client.json(`/assets/${safeId}`);
        if (asset?.visibility && asset.visibility !== 'timeline') throw photoError(404, 'PHOTOS_NOT_FOUND', 'Immich has no such item');
      }
      return client.image(`/assets/${safeId}/thumbnail?size=${wanted}`);
    },

    async setDescription(id, description) {
      const settings = client.settings();
      if (!settings.enabled) throw photoError(503, 'PHOTOS_NOT_CONFIGURED', 'Photos are not configured on this instance');
      if (!settings.descriptionWriteEnabled) {
        throw photoError(403, 'PHOTOS_WRITE_DISABLED', 'Writing photo descriptions is off on this instance');
      }
      const safeId = immichId(id);
      if (typeof description !== 'string') throw bad('description must be text');
      const value = description.trim();
      if (value.length > MAX_DESCRIPTION) throw bad(`description is longer than ${MAX_DESCRIPTION} characters`);
      await client.json(`/assets/${safeId}`, { method: 'PUT', body: { description: value } });
      return service.asset(safeId);
    },
  };
  return service;
}

module.exports = { createPhotoService, ocrText, MAX_LIMIT, REVIEW_PENDING_TAG };
