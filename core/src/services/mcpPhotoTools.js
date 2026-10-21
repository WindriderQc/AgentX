'use strict';

// Household photo tools for the Core MCP bus, over the same service as
// /api/photos. Core holds the only Immich key; callers never see it.

const { createPhotoService } = require('./photos/photoService');

let defaultService = null;
const service = (deps) => deps.photoService || (defaultService ??= createPhotoService());

function objectSchema(properties, required = []) {
  return { type: 'object', properties, required, additionalProperties: false };
}

const short = (description) => ({ type: 'string', minLength: 1, maxLength: 120, description });
const FILTERS = {
  person: short('Name(s) of people in the photo, comma-separated for "all of them". A first name works when it designates one person.'),
  city: short('City as Immich geocoded it; accents and case are ignored.'),
  state: short('State or province.'),
  country: short('Country.'),
  tag: short('Tag path (AgentX/Saison/été) or its last part (été).'),
  year: { type: 'string', pattern: '^\\d{4}$' },
  from: { type: 'string', maxLength: 40, description: '2025, 2025-07, 2025-07-14 or an ISO time; inclusive.' },
  to: { type: 'string', maxLength: 40, description: 'Same forms; a partial date covers its whole period.' },
  audience: { type: 'string', enum: ['owner', 'family'], default: 'owner', description: 'family for children and family surfaces: no hidden photo, no unreviewed generated text.' },
};
const EXACT = {
  text: short('Words in the description.'),
  ocr: short('Text visible in the photo.'),
};
const READ_ONLY = { readOnlyHint: true, idempotentHint: true, openWorldHint: false };

const PHOTO_TOOLS = [
  {
    name: 'photo_search',
    title: 'Search Household Photos',
    description: 'Find household photos. With query: ranked by likeness to the words (French works: "à la plage"); it always returns its closest matches, so check photo_details before asserting what a photo shows. Without query: exact filters, newest first, paged with cursor. Answers carry Core thumbnail paths, people names, place and placeCoverage (only photos with GPS have a place).',
    inputSchema: objectSchema({
      query: { type: 'string', minLength: 1, maxLength: 300 },
      ...FILTERS, ...EXACT,
      order: { type: 'string', enum: ['asc', 'desc'] },
      cursor: { type: 'string', maxLength: 500 },
      limit: { type: 'integer', minimum: 1, maximum: 50, default: 20 },
    }),
    annotations: READ_ONLY,
  },
  {
    name: 'photo_count',
    title: 'Count Household Photos',
    description: 'Count household photos matching exact filters. Say "at least" when exact is false.',
    inputSchema: objectSchema({ ...FILTERS, ...EXACT }),
    annotations: READ_ONLY,
  },
  {
    name: 'photo_details',
    title: 'Household Photo Details',
    description: 'One photo: date, place, people, description, tags, text read in the photo, thumbnail and preview paths on Core.',
    inputSchema: objectSchema({ id: { type: 'string', pattern: '^[0-9a-fA-F-]{36}$' }, audience: FILTERS.audience }, ['id']),
    annotations: READ_ONLY,
  },
  {
    name: 'photo_names',
    title: 'Household Photo Names',
    description: 'The names photo filters accept: named people, geocoded places (cities, states, countries) or tags.',
    inputSchema: objectSchema({ kind: { type: 'string', enum: ['people', 'places', 'tags'] }, audience: FILTERS.audience }, ['kind']),
    annotations: READ_ONLY,
  },
];

function plain(args) {
  if (!args || typeof args !== 'object' || Array.isArray(args)) {
    throw Object.assign(new Error('arguments must be an object'), { code: 'INVALID_ARGUMENTS', status: 400 });
  }
  return Object.fromEntries(Object.entries(args).map(([key, value]) => [key, typeof value === 'number' ? String(value) : value]));
}

// Tool errors carry only code and message: name the candidates in the message.
async function run(fn) {
  try { return await fn(); } catch (error) {
    const candidates = error.details?.candidates;
    if (Array.isArray(candidates) && candidates.length) error.message = `${error.message}. Candidates: ${candidates.join(', ')}`;
    throw error;
  }
}

const PHOTO_TOOL_HANDLERS = {
  photo_search: (args, deps = {}) => run(() => {
    const input = plain(args);
    const { query, ...filters } = input;
    return query ? service(deps).smartSearch({ q: query, ...filters }) : service(deps).metadataSearch(filters);
  }),
  photo_count: (args, deps = {}) => run(() => service(deps).count(plain(args))),
  photo_details: (args, deps = {}) => run(() => {
    const input = plain(args);
    return service(deps).asset(input.id, { audience: input.audience });
  }),
  photo_names: (args, deps = {}) => run(async () => {
    const input = plain(args);
    if (input.kind === 'people') return service(deps).people({});
    if (input.kind === 'places') return service(deps).places();
    if (input.kind === 'tags') return service(deps).tags({ audience: input.audience });
    throw Object.assign(new Error('kind must be people, places or tags'), { code: 'INVALID_ARGUMENTS', status: 400 });
  }),
};

module.exports = { PHOTO_TOOLS, PHOTO_TOOL_HANDLERS };
