'use strict';

/**
 * 3D views of an island run, behind one small interface so a renderer
 * (Clawblox's own pages or GraphysX-Web) changes without touching the tab (docs/ISLAND.md):
 *
 *   available()           -> { live, replay }  what this renderer can show
 *   liveUrl(run)          -> URL or null       while the run is running
 *   replayUrl(run, deps)  -> { src, agentLog } opens the run's recording
 *
 * `run` is the stored run record (phase, liveView {port, path}, recording).
 * The physics and the recording stay Clawblox's; a renderer only shows them.
 */

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

/** Clawblox's own spectator (live) and `clawblox app` replay server. */
function clawbloxViews(env = process.env) {
  const live = origin(env.AGENTX_ISLAND_VIEW_ORIGIN);
  const replay = origin(env.AGENTX_ISLAND_REPLAY_URL);
  const liveOrigin = live && !live.port ? `${live.protocol}//${live.hostname}` : null;
  const replayBase = replay ? replay.origin : null;
  return {
    name: 'clawblox',
    available: () => ({ live: Boolean(liveOrigin), replay: Boolean(replayBase) }),
    liveUrl: run => (liveOrigin && run?.phase === 'running' && run.liveView?.port && run.liveView?.path
      ? `${liveOrigin}:${run.liveView.port}${run.liveView.path}` : null),
    replayUrl: async (run, { fetchImpl = fetch } = {}) => {
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
 * GraphysX-Web's island page (`?app=island`), drawing the state that Clawblox
 * streams on `/spectate/ws`. Clawblox still serves the world and the replay;
 * only the page changes. The spectator token travels in the fragment.
 */
function graphysxViews(env = process.env) {
  const clawblox = clawbloxViews(env);
  const viewer = viewerBase(env.AGENTX_ISLAND_GRAPHYSX_URL);
  const page = (source, token) => {
    const url = new URL(viewer);
    url.searchParams.set('app', 'island');
    url.searchParams.set('embed', '1');
    url.searchParams.set('source', source);
    if (token) url.hash = `spectator_token=${encodeURIComponent(token)}`;
    return url.toString();
  };
  return {
    name: 'graphysx',
    available: () => (viewer ? clawblox.available() : { live: false, replay: false }),
    liveUrl: run => {
      const live = viewer ? clawblox.liveUrl(run) : null;
      if (!live) return null;
      const url = new URL(live);
      return page(url.origin, url.searchParams.get('spectator_token'));
    },
    replayUrl: async (run, deps) => {
      if (!viewer) throw new ViewError('No GraphysX viewer is configured (AGENTX_ISLAND_GRAPHYSX_URL)', 409);
      const opened = await clawblox.replayUrl(run, deps);
      return { ...opened, src: page(opened.src.replace(/\/+$/, '')) };
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
