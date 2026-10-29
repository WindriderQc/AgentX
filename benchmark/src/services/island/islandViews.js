'use strict';

/**
 * 3D views of an island run, behind one small interface so another renderer
 * can replace Clawblox's own frontend without touching the tab (docs/ISLAND.md):
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

// A second renderer (for example a GraphysX-Web viewer fed by Clawblox's
// entity state) registers here with the same three functions.
const RENDERERS = Object.freeze({ clawblox: clawbloxViews });

function islandViews(env = process.env, name = 'clawblox') {
  const make = RENDERERS[name];
  if (!make) throw new ViewError(`Unknown island renderer: ${name}`, 500);
  return make(env);
}

module.exports = { islandViews, ViewError, RENDERERS };
