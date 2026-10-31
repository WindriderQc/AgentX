'use strict';

// The terrain selected for the next run is not necessarily the world a shared
// live service is running now. Read its identity; watching never changes it.
const { islandWorlds, findWorld } = require('./islandWorlds');
const { islandViews } = require('./islandViews');

const WORLD_ID = /^[a-z0-9][a-z0-9-]{0,63}$/;

async function readLiveWorld(id, { env = process.env, fetchImpl = fetch } = {}) {
  const { worlds } = islandWorlds(env);
  const selected = findWorld(worlds, id);
  if (!selected) throw Object.assign(new Error('No configured terrain with this id'), { statusCode: 404 });
  const liveUrl = islandViews(env).worldUrl(selected);
  const unavailable = { selectedId: id, available: false, activeWorld: null, selectedActive: null, liveUrl: null };
  if (!selected.live || !liveUrl) return unavailable;
  try {
    const response = await fetchImpl(`${selected.live}/healthz`, {
      method: 'GET', redirect: 'error', headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(3000)
    });
    if (!response.ok) return unavailable;
    const health = await response.json();
    if (health?.ok !== true || typeof health.world !== 'string' || !WORLD_ID.test(health.world)) return unavailable;
    const active = worlds.find(world => world.live === selected.live && (world.liveWorld || world.id) === health.world);
    return { selectedId: id, available: true, selectedActive: (selected.liveWorld || selected.id) === health.world,
      activeWorld: { id: health.world, label: active?.label || health.world },
      instanceId: health.instanceId || null, recordingId: health.recordingId || null, liveUrl };
  } catch {
    return unavailable;
  }
}

module.exports = { readLiveWorld };
