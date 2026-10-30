'use strict';

/**
 * 3D views of an island run, behind one small interface so a renderer
 * (Clawblox's own pages or GraphysX-Web) changes without touching the tab (docs/ISLAND.md):
 *
 *   available()           -> { live, replay }  what this renderer can show
 *   liveUrl(run)          -> URL or null       while the run is running
 *   replayUrl(run, deps)  -> { src, agentLog } opens the run's recording
 *   worldUrl(world)       -> URL or null       watches a terrain that runs on its own
 *
 * `run` is the stored run record (phase, world, liveView {port, path}, recording).
 * On a Clawblox world the physics and the recording stay Clawblox's; a world
 * with a `live` origin (islandWorlds.js) is a GraphysX-Web world service that
 * runs on its own: only GraphysX-Web's page can show it, and its per-run
 * replays are not wired yet.
 */

const { islandWorlds, findWorld } = require('./islandWorlds');

class ViewError extends Error {
  constructor(message, statusCode) { super(message); this.statusCode = statusCode; }
}

function origin(value) {
  if (!value) return null;
  try {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.pathname !== '/' || url.search || url.hash) return null;
    return url;
  } catch { return null; }
}

/** The run's terrain when it runs on its own (a world service), else null. */
function remoteWorld(worlds, run) {
  const world = run?.world ? findWorld(worlds, run.world) : null;
  return world?.live ? world : null;
}

function refuseRemoteReplay(world) {
  throw new ViewError(`Replays of ${world.label} are not available here yet`, 409);
}

/** Clawblox's own spectator (live) and `clawblox app` replay server. */
function clawbloxViews(env = process.env) {
  const { worlds } = islandWorlds(env);
  const live = origin(env.AGENTX_ISLAND_VIEW_ORIGIN);
  const replay = origin(env.AGENTX_ISLAND_REPLAY_URL);
  const liveOrigin = live && !live.port ? `${live.protocol}//${live.hostname}` : null;
  const replayBase = replay ? replay.origin : null;
  return {
    name: 'clawblox',
    available: () => ({ live: Boolean(liveOrigin), replay: Boolean(replayBase) }),
    liveUrl: run => (liveOrigin && run?.phase === 'running' && !remoteWorld(worlds, run) && run.liveView?.port && run.liveView?.path
      ? `${liveOrigin}:${run.liveView.port}${run.liveView.path}` : null),
    worldUrl: () => null,
    replayUrl: async (run, { fetchImpl = fetch } = {}) => {
      const remote = remoteWorld(worlds, run);
      if (remote) refuseRemoteReplay(remote);
      if (!replayBase) throw new ViewError('No replay server is configured (AGENTX_ISLAND_REPLAY_URL)', 409);
      if (!run?.recording) throw new ViewError('This run has no recording yet', 404);
      const response = await fetchImpl(`${replayBase}/api/open-replay`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: run.recording }), signal: AbortSignal.timeout(20000)
      });
      if (!response.ok) throw new ViewError(`The replay server refused: HTTP ${response.status}`, 502);
      const answer = await response.json();
      if (typeof answer.url !== 'string' || !/^\/[\w/.-]*$/.test(answer.url)) throw new ViewError('The replay server gave no session', 502);
      return { src: `${replayBase}${answer.url}`, agentLog: Boolean(answer.agent_log) };
    }
  };
}

/** A viewer page address: http(s), no credentials, query or fragment; a path is kept. */
function viewerBase(value) {
  if (!value) return null;
  try {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) return null;
    return url;
  } catch { return null; }
}

/**
 * GraphysX-Web's island page (`?app=island`, "GraphysX-screen"), drawing the
 * state that Clawblox streams on `/spectate/ws`, or a world service's
 * `/spectate` stream. Clawblox still serves its world and the replay; only the
 * page changes. The spectator token travels in the fragment.
 */
function graphysxViews(env = process.env) {
  const { worlds } = islandWorlds(env);
  const clawblox = clawbloxViews(env);
  const viewer = viewerBase(env.AGENTX_ISLAND_GRAPHYSX_URL);
  const page = (source, token, agent) => {
    const url = new URL(viewer);
    url.searchParams.set('app', 'island');
    url.searchParams.set('embed', '1');
    url.searchParams.set('source', source);
    if (typeof agent === 'string' && /^[A-Za-z][A-Za-z0-9_-]{0,31}$/.test(agent)) url.searchParams.set('agent', agent);
    if (token) url.hash = `spectator_token=${encodeURIComponent(token)}`;
    return url.toString();
  };
  return {
    name: 'graphysx',
    available: () => (viewer ? clawblox.available() : { live: false, replay: false }),
    liveUrl: run => {
      const remote = remoteWorld(worlds, run);
      if (remote) return viewer && run.phase === 'running' ? page(remote.live, null, run.agent) : null;
      const live = viewer ? clawblox.liveUrl(run) : null;
      if (!live) return null;
      const url = new URL(live);
      return page(url.origin, url.searchParams.get('spectator_token'), run.agent);
    },
    worldUrl: world => (viewer && world?.live ? page(world.live, null, null) : null),
    replayUrl: async (run, deps) => {
      const remote = remoteWorld(worlds, run);
      if (remote) refuseRemoteReplay(remote);
      if (!viewer) throw new ViewError('No GraphysX viewer is configured (AGENTX_ISLAND_GRAPHYSX_URL)', 409);
      const opened = await clawblox.replayUrl(run, deps);
      return { ...opened, src: page(opened.src.replace(/\/+$/, ''), null, run?.agent) };
    }
  };
}

const RENDERERS = Object.freeze({ clawblox: clawbloxViews, graphysx: graphysxViews });

/** GraphysX when its viewer is configured, else Clawblox's own pages; AGENTX_ISLAND_RENDERER forces one. */
function defaultRenderer(env) {
  return env.AGENTX_ISLAND_RENDERER || (env.AGENTX_ISLAND_GRAPHYSX_URL ? 'graphysx' : 'clawblox');
}

function islandViews(env = process.env, name = defaultRenderer(env)) {
  const make = RENDERERS[name];
  if (!make) throw new ViewError(`Unknown island renderer: ${name}`, 500);
  return make(env);
}

module.exports = { islandViews, ViewError, RENDERERS };
