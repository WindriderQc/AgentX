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

// Required services decide whether AgentX is down. An optional service (Data,
// Compose profile `data`) that is stopped or not deployed only degrades the
// tile, and the detail names it.
function agentxCrew(services = []) {
  const required = services.filter(service => !service.optional);
  const ready = required.filter(service => service.status === 'ok').length;
  const unavailable = services.filter(service => service.optional && service.status !== 'ok');
  const detail = `${ready}/${required.length} platform services ready`;
  return {
    id: 'agentx',
    name: 'AgentX',
    role: 'Router · RAG · shared memory authority',
    status: ready !== required.length ? 'down' : unavailable.length ? 'degraded' : 'ok',
    detail: unavailable.length
      ? `${detail} · optional ${unavailable.map(service => service.name).join(', ')} unavailable`
      : detail,
    href: '/agent-ops'
  };
}

function panelCrewReady(crew, fleet) {
  return crew.every(member => member.status === 'ok' || (member.id === 'openclaw' && member.status === 'unknown'))
    && fleet.status === 'ok';
}

module.exports = { agentxCrew, openClawCrew, openClawPanelStatus, panelCrewReady };
