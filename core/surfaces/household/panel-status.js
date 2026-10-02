'use strict';

const OPENCLAW_STATUS_TIMEOUT_MS = 3000;
const TIMEOUT = Symbol('openclaw-status-timeout');

function openClawCrew(body = {}) {
  const agents = Math.max(0, Number(body.agents || 0));
  const ready = body.status === 'online' && body.gateway?.reachable === true;
  return {
    id: 'openclaw',
    name: 'OpenClaw',
    role: "Dad's agent team",
    status: ready ? 'ok' : 'down',
    detail: ready ? `${agents} agents ready` : 'agent gateway unavailable',
    agents,
    href: '/api/openclaw/control-launch/chat'
  };
}

function unknownOpenClawCrew(error) {
  return {
    ...openClawCrew(),
    status: 'unknown',
    detail: 'agent status unavailable',
    error
  };
}

async function openClawPanelStatus(evidence, timeoutMs = OPENCLAW_STATUS_TIMEOUT_MS) {
  if (evidence?.contractVersion !== 1 || typeof evidence.getOpenClawStatusProjection !== 'function') {
    return unknownOpenClawCrew('AgentX runtime evidence is unavailable');
  }
  const startedAt = Date.now();
  let timer;
  try {
    const result = await Promise.race([
      Promise.resolve().then(() => evidence.getOpenClawStatusProjection()),
      new Promise(resolve => { timer = setTimeout(() => resolve(TIMEOUT), timeoutMs); })
    ]);
    const latencyMs = Date.now() - startedAt;
    if (result === TIMEOUT) return { ...unknownOpenClawCrew('OpenClaw status evidence timed out'), latencyMs };
    if (!result || !['online', 'offline'].includes(result.status)) {
      return { ...unknownOpenClawCrew('OpenClaw status evidence was invalid'), latencyMs };
    }
    return { ...openClawCrew(result), latencyMs };
  } catch {
    return { ...unknownOpenClawCrew('OpenClaw status evidence failed'), latencyMs: Date.now() - startedAt };
  } finally {
    clearTimeout(timer);
  }
}

function panelCrewReady(crew, fleet) {
  return crew.every(member => member.status === 'ok' || (member.id === 'openclaw' && member.status === 'unknown'))
    && fleet.status === 'ok';
}

module.exports = { openClawCrew, openClawPanelStatus, panelCrewReady };
