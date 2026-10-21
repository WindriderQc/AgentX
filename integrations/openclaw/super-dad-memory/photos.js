import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { privateOwnerContext } from './store.js';
import { configuredAgents } from './continuity.js';
import { mediaRoot } from './media.js';

// Household photos through Core's /api/photos (Core holds the only Immich
// key). The owner gets everything; a household agent other than main (a
// child's or family member's session) always reads with audience=family:
// no hidden photo and no generated text the owner has not reviewed. The
// audience comes from the host session, never from the tool parameters.

const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const IMAGE_EXT = Object.freeze({ 'image/jpeg': '.jpg', 'image/webp': '.webp', 'image/png': '.png' });
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const MAX_SHOWN = 4;
const FILTERS = ['person', 'city', 'state', 'country', 'tag', 'year', 'from', 'to', 'text', 'ocr', 'order', 'cursor', 'limit'];

const HOUSEHOLD_SESSION = /^agent:([a-z0-9][a-z0-9_-]*):household:direct:[a-f0-9-]{36}$/;

export function photoAudience(context = {}, config = {}) {
  if (privateOwnerContext(context, config)) return 'owner';
  const match = HOUSEHOLD_SESSION.exec(context.sessionKey || '');
  if (match && match[1] !== 'main' && context.agentId === match[1] && !context.sandboxed
      && configuredAgents(config)[match[1]]) return 'family';
  return null;
}

async function readCore(base, route, params, fetchImpl) {
  const url = new URL(route, base);
  for (const [key, value] of Object.entries(params)) if (value !== undefined && value !== null && value !== '') url.searchParams.set(key, String(value));
  const response = await fetchImpl(url, { redirect: 'error', signal: AbortSignal.timeout(20000),
    headers: { accept: 'application/json', 'x-service-caller': 'nestor-photos' } });
  const body = await response.json().catch(() => null);
  if (!response.ok || !body?.ok) {
    const error = body?.error || {};
    const candidates = Array.isArray(error.details?.candidates) && error.details.candidates.length
      ? ` Candidates: ${error.details.candidates.join(', ')}` : '';
    throw new Error(`${error.code || 'PHOTOS_UNAVAILABLE'}: ${String(error.message || 'Photos unavailable').slice(0, 300)}${candidates}`);
  }
  return body.data;
}

export function registerPhotos(api, { fetchImpl = fetch, name = 'nestor_photos' } = {}) {
  api.registerTool(context => {
    const audience = photoAudience(context, api.config);
    if (!audience) return null;
    const base = api.pluginConfig?.agentxUrl;
    return {
      name, label: 'Household Photos',
      description: [
        'Household photos (Immich through AgentX Core). action=search with query finds photos by what they show (French works: "à la plage"),',
        'filtered by person (a first name works), city/state/country, tag, year or from/to; without query it is an exact, dated search.',
        'Words-based search always returns its closest matches: check details or show before saying what a photo contains.',
        'count answers "how many"; details reads one photo (date, place, people, description, text in the photo); names lists known people, places or tags;',
        'show attaches up to 4 photos to your reply (cite each as MEDIA:<path>). Only photos with GPS have a place: say so when placeCoverage is present.',
        audience === 'family' ? 'This is a family conversation: hidden photos and unreviewed descriptions are already left out.' : '',
      ].join(' ').trim(),
      parameters: {
        type: 'object', additionalProperties: false, required: ['action'],
        properties: {
          action: { type: 'string', enum: ['search', 'count', 'details', 'names', 'show'] },
          query: { type: 'string', maxLength: 300 },
          person: { type: 'string', maxLength: 300 }, city: { type: 'string', maxLength: 120 },
          state: { type: 'string', maxLength: 120 }, country: { type: 'string', maxLength: 120 },
          tag: { type: 'string', maxLength: 120 }, year: { type: 'string', pattern: '^\\d{4}$' },
          from: { type: 'string', maxLength: 40 }, to: { type: 'string', maxLength: 40 },
          text: { type: 'string', maxLength: 120 }, ocr: { type: 'string', maxLength: 120 },
          order: { type: 'string', enum: ['asc', 'desc'] }, cursor: { type: 'string', maxLength: 500 },
          limit: { type: 'integer', minimum: 1, maximum: 50 },
          kind: { type: 'string', enum: ['people', 'places', 'tags'] },
          ids: { type: 'array', items: { type: 'string', pattern: ID.source }, minItems: 1, maxItems: MAX_SHOWN },
        },
      },
      async execute(_id, params = {}) {
        if (!base) throw new Error('AgentX Core address is not configured');
        const filters = Object.fromEntries(FILTERS.filter(key => params[key] !== undefined).map(key => [key, params[key]]));
        let result;
        if (params.action === 'search') {
          result = params.query
            ? await readCore(base, '/api/photos/search/smart', { q: params.query, ...filters, audience }, fetchImpl)
            : await readCore(base, '/api/photos/search', { ...filters, audience }, fetchImpl);
        } else if (params.action === 'count') {
          result = await readCore(base, '/api/photos/count', { ...filters, audience }, fetchImpl);
        } else if (params.action === 'details') {
          const id = params.ids?.[0];
          if (!ID.test(id || '')) throw new Error('details needs ids with one photo id');
          result = await readCore(base, `/api/photos/assets/${id.toLowerCase()}`, { audience }, fetchImpl);
        } else if (params.action === 'names') {
          const kind = params.kind || 'people';
          result = await readCore(base, `/api/photos/${kind}`, kind === 'tags' ? { audience } : {}, fetchImpl);
        } else if (params.action === 'show') {
          return show(params.ids || []);
        } else {
          throw new Error('Unknown action');
        }
        return { content: [{ type: 'text', text: JSON.stringify(result) }], details: result };
      },
    };

    // Core's links only open at home: copy each preview into the media
    // directory so Household and Telegram can show the picture itself.
    async function show(ids) {
      if (!ids.length || ids.length > MAX_SHOWN || !ids.every(id => ID.test(id))) throw new Error(`show needs 1 to ${MAX_SHOWN} photo ids`);
      const dir = path.join(mediaRoot(process.env, api.pluginConfig?.mediaRoot), 'photos');
      await mkdir(dir, { recursive: true });
      const content = []; const shown = [];
      for (const raw of ids) {
        const id = raw.toLowerCase();
        const url = new URL(`/api/photos/assets/${id}/thumbnail`, base);
        url.searchParams.set('size', 'preview'); url.searchParams.set('audience', audience);
        const response = await fetchImpl(url, { redirect: 'error', signal: AbortSignal.timeout(30000), headers: { 'x-service-caller': 'nestor-photos' } });
        const type = String(response.headers.get('content-type') || '').split(';')[0].trim();
        if (!response.ok || !IMAGE_EXT[type]) { shown.push({ id, error: response.status === 404 ? 'not available' : 'unavailable' }); continue; }
        const bytes = Buffer.from(await response.arrayBuffer());
        if (bytes.length > MAX_IMAGE_BYTES) { shown.push({ id, error: 'too large' }); continue; }
        const file = path.join(dir, `${id}-preview${IMAGE_EXT[type]}`);
        await writeFile(file, bytes);
        shown.push({ id, mediaPath: file, deliveryHint: `Use MEDIA:${file} to present this photo.` });
        content.push({ type: 'image', mimeType: type, data: bytes.toString('base64') });
      }
      const result = { shown };
      return { content: [{ type: 'text', text: JSON.stringify(result) }, ...content], details: result };
    }
  }, { name, optional: true });
}
