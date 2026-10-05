'use strict';

// #143: an opted-in OpenClaw conversation (the busy-reply provider) may be
// served by a light task's fallback rung when its exact primary model is
// unavailable. Cron turns use the plain provider and never degrade. The
// degraded turn is local only, carries no tools (#92: tool and memory use with
// the smaller model needs its own evidence), tells the model which brain is
// speaking and shows the user a one-line notice.
const FALLBACK_TASK_ENV = 'OPENCLAW_CONVERSATION_FALLBACK_TASK';
// With a fallback configured, the primary wait for a yielding workload stays
// short enough for the fallback answer to fit under the gateway timeout.
const PRIMARY_WAIT_WITH_FALLBACK_MS = 30000;
const FALLBACK_WAIT_MS = 10000;
// Host-state refusals raised before generation (shared with the busy reply).
const LOCAL_INFERENCE_CONFLICTS = new Set([
  'BENCHMARK_CLAIM_ACTIVE',
  'RUNTIME_INFERENCE_ADMISSION_DENIED',
  'RUNTIME_INFERENCE_RECOVERY_REQUIRED'
]);

const REASON_LABELS = Object.freeze({
  primary_busy: 'occupé par une autre requête',
  benchmark_claim: 'réservé par une campagne benchmark',
  session_hold: 'réservé par une session',
  admission_blocked: 'réservé par une autre charge de travail',
  quarantined: "en attente d'une intervention",
  host_down: 'injoignable',
  host_unconfigured: 'non configuré',
  host_gpu_degraded: 'sans GPU disponible',
  vram_spill: 'hors de la mémoire GPU',
  dispatch_refused: 'indisponible'
});

function conversationFallbackTask(env = process.env) {
  return String(env[FALLBACK_TASK_ENV] || '').trim() || null;
}

function reasonLabel(routing) {
  return REASON_LABELS[routing?.reason] || 'indisponible';
}

function fallbackNotice(routing) {
  return `🪶 Cerveau léger (${routing.fallbackTo.model}) : le cerveau principal est ${reasonLabel(routing)}.`;
}

function brainContext(routing) {
  return `Contexte AgentX : ce tour est servi par le cerveau léger ${routing.fallbackTo.model}, `
    + `parce que le cerveau principal ${routing.fallbackFrom.model || ''} est ${reasonLabel(routing)}. `
    + "Aucun outil ni aucune mémoire n'est disponible pendant ce tour. "
    + "Réponds brièvement et, si on te demande quel cerveau répond, dis-le.";
}

// The same logical turn, addressed to the fallback rung. OpenClaw's tool
// history stays readable; new tool calls and thinking are not offered.
function degradeRequest(request, plan) {
  const context = brainContext(plan.routing);
  const { tools: _tools, ...rest } = request;
  const degraded = {
    ...rest,
    model: plan.model,
    think: false,
    exclusiveHost: false,
    callerDetail: 'openclaw-conversation-fallback'
  };
  if (request.mode === 'chat') {
    // Some chat templates honour only a leading system message: extend it.
    const [first, ...others] = request.messages || [];
    degraded.messages = first?.role === 'system'
      ? [{ ...first, content: `${first.content || ''}\n\n${context}` }, ...others]
      : [{ role: 'system', content: context }, ...(request.messages || [])];
  }
  if (request.mode === 'generate') degraded.system = request.system ? `${context}\n\n${request.system}` : context;
  return degraded;
}

function applyDegradedHeaders(res, routing) {
  res.set('X-AgentX-Degraded', 'true');
  res.set('X-AgentX-Degraded-Reason', routing.reason || '');
  res.set('X-AgentX-Degraded-Primary-Model', routing.fallbackFrom.model || '');
  res.set('X-AgentX-Degraded-Actual-Model', routing.fallbackTo.model || '');
}

// First NDJSON frame of a degraded stream: the notice, as ordinary content.
function noticeFrame({ mode, model, routing, now = new Date() }) {
  const content = `${fallbackNotice(routing)}\n\n`;
  const base = { model, created_at: now.toISOString(), done: false };
  return `${JSON.stringify(mode === 'generate' ? { ...base, response: content } : { ...base, message: { role: 'assistant', content } })}\n`;
}

function markBody(mode, body, routing) {
  const notice = `${fallbackNotice(routing)}\n\n`;
  if (mode === 'generate' && typeof body?.response === 'string') return { ...body, response: notice + body.response };
  if (mode === 'chat' && body?.message) return { ...body, message: { ...body.message, content: notice + String(body.message.content || '') } };
  return body;
}

// Only a refusal proven before any model output may move the turn. Anything
// after dispatch (partial stream, timeout, unknown outcome) is never replayed.
function refusedBeforeOutput(error) {
  return LOCAL_INFERENCE_CONFLICTS.has(error?.code)
    || error?.ollamaRequestNotSent === true || error?.cause?.ollamaRequestNotSent === true;
}

// The primary's observed cause, as a bounded ladder reason (no host details).
function refusalReason(error) {
  if (error?.ollamaRequestNotSent === true || error?.cause?.ollamaRequestNotSent === true) return 'host_down';
  const failure = error?.failure || {};
  if (error?.code === 'RUNTIME_INFERENCE_RECOVERY_REQUIRED' || /recovery_required$/.test(failure.cause || '')) return 'quarantined';
  const holder = failure.holder || null;
  if (error?.code === 'BENCHMARK_CLAIM_ACTIVE' || /bench|judge/i.test(`${holder?.kind || ''} ${holder?.principal || ''}`)) {
    return 'benchmark_claim';
  }
  if (holder?.type === 'inference') return 'primary_busy';
  return error?.code === 'RUNTIME_INFERENCE_ADMISSION_DENIED' ? 'admission_blocked' : 'dispatch_refused';
}

// Neither brain answered: the busy reply names why the primary could not.
function busyError(primaryReason) {
  return Object.assign(new Error('The conversation fallback is unavailable.'), {
    code: 'RUNTIME_INFERENCE_ADMISSION_DENIED', statusCode: 503,
    failure: { cause: 'fallback_unavailable', primaryReason, holder: null }
  });
}

// Plan before dispatch (primary busy, down, quarantined...), else run the
// primary and degrade once if it refused before output. Session and return to
// the primary stay with OpenClaw: every turn plans again.
async function runWithConversationFallback({ runtimeServices, request, fallbackTask, primaryRun, signal, consumerContract, logger }) {
  const plan = (afterRefusal, refusal = null) => runtimeServices.routing.planFallback({
    model: request.model, taskType: fallbackTask, afterRefusal, ...(refusal && { refusalReason: refusal })
  }).catch((error) => {
    logger?.warn?.('OpenClaw conversation fallback planning failed', { code: error?.code || 'FALLBACK_PLAN_FAILED' });
    return null;
  });
  const runPlan = async (chosen, unavailable) => {
    try {
      // `degraded` lets Core record the turn as a fallback (#363).
      const result = await runtimeServices.inference.execute(degradeRequest(request, chosen), {
        signal, consumerContract, hostUrl: chosen.hostUrl, degraded: chosen.routing,
        retry: { interactive: true, interactiveWaitMs: FALLBACK_WAIT_MS }
      });
      return { result, plan: chosen };
    } catch (error) {
      // The rung refused before output too: the conversation hears the busy reply.
      if (!signal?.aborted && refusedBeforeOutput(error)) throw unavailable;
      throw error;
    }
  };
  const early = await plan(false);
  if (early) return runPlan(early, busyError(early.routing?.reason));
  try {
    return { result: await primaryRun(), plan: null };
  } catch (error) {
    if (signal?.aborted || !refusedBeforeOutput(error)) throw error;
    const reason = refusalReason(error);
    const late = await plan(true, reason);
    if (!late) throw error;
    return runPlan(late, LOCAL_INFERENCE_CONFLICTS.has(error.code) ? error : busyError(reason));
  }
}

module.exports = {
  LOCAL_INFERENCE_CONFLICTS,
  reasonLabel,
  refusalReason,
  refusedBeforeOutput,
  runWithConversationFallback,
  FALLBACK_TASK_ENV,
  FALLBACK_WAIT_MS,
  PRIMARY_WAIT_WITH_FALLBACK_MS,
  applyDegradedHeaders,
  brainContext,
  conversationFallbackTask,
  degradeRequest,
  fallbackNotice,
  markBody,
  noticeFrame
};
