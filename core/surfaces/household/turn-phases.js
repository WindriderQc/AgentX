'use strict';

// Where a turn's server time went, as bounded whole milliseconds. `prepared`
// and `executed` count from the start of the turn request: the context is ready
// and the model or agent is about to be called, then its answer is back. For a
// native agent run, `agent` holds the steps of that run from its own request:
// accepted by the gateway, run created, first generation or tool event, end of
// the stream, final answer read. Numbers only; a missing step stays absent.
const AGENT_PHASES = Object.freeze(['accepted', 'runCreated', 'generating', 'streamEnd', 'answer']);
const MAX_MS = 15 * 60 * 1000;

const bounded = value => (typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= MAX_MS ? Math.round(value) : undefined);

function serverTimingsOf({ prepared, executed, agent } = {}) {
  const timings = {};
  for (const [name, value] of [['prepared', bounded(prepared)], ['executed', bounded(executed)]]) {
    if (value !== undefined) timings[name] = value;
  }
  const steps = {};
  for (const name of AGENT_PHASES) {
    const value = bounded(agent?.[name]);
    if (value !== undefined) steps[name] = value;
  }
  if (Object.keys(steps).length) timings.agent = steps;
  return Object.keys(timings).length ? { serverTimings: timings } : {};
}

module.exports = { serverTimingsOf, AGENT_PHASES };
