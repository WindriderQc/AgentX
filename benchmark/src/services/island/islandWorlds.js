'use strict';

/**
 * The terrains an island run can play on (docs/ISLAND.md, "Terrains").
 *
 * AGENTX_ISLAND_WORLDS is a JSON list; each entry names a world directory of
 * the runner (`world` in the queue executor), a label for the tab and, for a
 * world that runs on its own (a GraphysX-Web world service), the origin where
 * its live stream is watched:
 *
 *   [{"id":"mesa-island","label":"Île Clawblox"},
 *    {"id":"ile-de-frank","label":"Île de Frank","live":"https://host:18794"}]
 *
 * Unset, the tab keeps its single terrain, `mesa-island`. A world without
 * `live` is a Clawblox world served by the runner; its views stay Clawblox's.
 */

const WORLD = /^[a-z0-9][a-z0-9-]{0,63}$/;
const MAX_WORLDS = 8;
const DEFAULT_WORLDS = Object.freeze([Object.freeze({ id: 'mesa-island', label: 'Île Clawblox', live: null })]);

/** A world-service origin: http(s), no credentials, path, query or fragment. */
function liveOrigin(value) {
  if (typeof value !== 'string' || !value) return null;
  try {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.pathname !== '/' || url.search || url.hash) return null;
    return url.origin;
  } catch { return null; }
}

/** { worlds, error }: the configured terrains, or the default one and why the setting was refused. */
function islandWorlds(env = process.env) {
  const raw = env.AGENTX_ISLAND_WORLDS;
  if (!raw || !String(raw).trim()) return { worlds: DEFAULT_WORLDS, error: null };
  let list;
  try { list = JSON.parse(raw); } catch { return { worlds: DEFAULT_WORLDS, error: 'AGENTX_ISLAND_WORLDS is not JSON' }; }
  if (!Array.isArray(list) || !list.length || list.length > MAX_WORLDS) {
    return { worlds: DEFAULT_WORLDS, error: `AGENTX_ISLAND_WORLDS needs a list of 1 to ${MAX_WORLDS} worlds` };
  }
  const worlds = [];
  for (const entry of list) {
    const id = entry?.id;
    if (typeof id !== 'string' || !WORLD.test(id) || worlds.some(world => world.id === id)) {
      return { worlds: DEFAULT_WORLDS, error: 'AGENTX_ISLAND_WORLDS has a missing, invalid or repeated id' };
    }
    const live = entry.live === undefined || entry.live === null ? null : liveOrigin(entry.live);
    if (entry.live && !live) return { worlds: DEFAULT_WORLDS, error: `AGENTX_ISLAND_WORLDS: ${id} needs an origin for live` };
    if (entry.liveWorld !== undefined && (!live || typeof entry.liveWorld !== 'string' || !WORLD.test(entry.liveWorld))) {
      return { worlds: DEFAULT_WORLDS, error: `AGENTX_ISLAND_WORLDS: ${id} needs a valid liveWorld and live origin` };
    }
    const label = typeof entry.label === 'string' && entry.label.trim() ? entry.label.trim().slice(0, 60) : id;
    worlds.push(Object.freeze({ id, label, live, ...(entry.liveWorld === undefined ? {} : { liveWorld: entry.liveWorld }) }));
  }
  return { worlds: Object.freeze(worlds), error: null };
}

/** The configured world for an id, or null. */
function findWorld(worlds, id) {
  return worlds.find(world => world.id === id) || null;
}

module.exports = { islandWorlds, findWorld, DEFAULT_WORLDS };
