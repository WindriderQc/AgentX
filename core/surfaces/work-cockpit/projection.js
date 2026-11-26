'use strict';

const identifier = value => typeof value === 'string' && /^[a-z0-9_.-]{1,80}$/i.test(value) ? value : null;
const timestamp = value => value && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : null;
function projectTeam(team) {
  if (team.readOnly !== true || !Array.isArray(team.agents)) throw new Error('Unexpected registry');
  return {observedAt: timestamp(team.generatedAt), agents: team.agents.map(entry => {
    const id = identifier(entry.registryId);
    if (!id) throw new Error('Invalid registry identity');
    return {id, persona: typeof entry.persona?.label === 'string' ? entry.persona.label.slice(0,80) : null,
      runtime: identifier(entry.runtime),
      observation: entry.confidence === 'live' ? 'observed' : entry.confidence === 'configured' ? 'configured' : 'unknown'};
  })};
}

// All readers of one source share one deadline and one underlying operation.
// Keep the slot until the provider settles, even if the HTTP deadline expires.
function sourceReader(provider, deadlineMs) {
  let inFlight;
  return function read() {
    if (inFlight) return inFlight;
    let timer;
    const checkedAt = new Date().toISOString();
    const work = Promise.resolve().then(provider)
      .then(data => ({state:'read', checkedAt, ...data}),
        () => ({state:'unavailable', reason:'source_indisponible', checkedAt}))
      .finally(() => { clearTimeout(timer); inFlight = undefined; });
    const deadline = new Promise(resolve => {
      timer = setTimeout(() => resolve({state:'unavailable', reason:'timeout', checkedAt}), deadlineMs);
    });
    inFlight = Promise.race([work, deadline]);
    return inFlight;
  };
}

module.exports = {sourceReader, projectTeam};
