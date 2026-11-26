'use strict';

const events = new Set(['intake_decision', 'transition', 'created']);
const identifier = value => typeof value === 'string' && /^[a-z0-9_.-]{1,80}$/i.test(value) ? value : null;
const timestamp = value => value && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : null;
function count(value) {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error('Invalid count');
  return value;
}

function projectDossier({task}, scope) {
  if (!task || task.pipelineId !== scope.pipelineId || task.service !== scope.service ||
      task.nextAction.reference !== '/pipeline?task=' + scope.pipelineId) throw new Error('Unexpected scope');
  return {observedAt: timestamp(task.nextAction.observedAt), record: {
    pipelineId: scope.pipelineId, label: scope.label, intent: scope.intent, assigned: Boolean(task.assignee),
    status: identifier(task.status), intake: identifier(task.intakeView.state),
    nextAction: identifier(task.nextAction.code), updatedAt: timestamp(task.updatedAt),
    attempts: count(task.automationAttemptCount), relationships: count(task.workView.entryCount),
    timeline: task.timeline.filter(event => events.has(event.kind))
      .map(event => ({kind: event.kind, at: timestamp(event.at)}))
  }};
}

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

async function read(source) {
  try { return {state:'read', ...await source()}; }
  catch { return {state:'unavailable', reason:'source_indisponible'}; }
}

async function snapshot({scope, readDossier, readTeam}) {
  const [pipeline, registry] = await Promise.all([
    read(async () => projectDossier(await readDossier({pipelineId:scope.pipelineId, pageChars:256}), scope)),
    read(async () => projectTeam(await readTeam()))
  ]);
  return {pipeline, registry, checkedAt:new Date().toISOString()};
}

module.exports = {snapshot};
