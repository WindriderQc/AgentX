import { createHash } from 'node:crypto';
import { privateOwnerContext, configuredJobContext } from '../action-provenance.mjs';

const STEPS = {
  plan_slot: 'planifier le créneau et choisir le mode de départ',
  prepare_executor: 'préparer un exécuteur validé pour cette proposition',
  review_window: 'réexaminer la fenêtre autorisée avant tout nouveau départ',
  review_schedule: 'vérifier la fenêtre manquante ou invalide',
  run_in_slot: 'déclencher pendant le créneau après les contrôles natifs',
  use_native_executor: 'suivre la procédure d’approbation et de départ de l’exécuteur',
  wait_slot: 'attendre le créneau et l’admission native',
  wait_not_before: 'attendre l’heure autorisée puis l’admission native',
  await_native_admission: 'attendre l’admission native dans la fenêtre autorisée',
};
const MODES = { manual: 'départ manuel', automatic: 'départ automatique', unconfigured: 'départ non configuré' };
const SLOTS = { open: 'créneau ouvert', upcoming: 'créneau à venir', expired: 'créneau expiré',
  invalid: 'créneau à vérifier', unreserved: 'sans réservation' };
const ACTORS = { operator: 'opérateur', core: 'Core', native_executor: 'exécuteur natif' };

// Cite one row from the page. The global counts come independently from Core's summary.
export function morningQueueExample(jobs) {
  if (!Array.isArray(jobs)) return null;
  const candidates = jobs.filter(job => job?.presentation && typeof job.id === 'string' && /^[a-z0-9-]+$/i.test(job.id)
    && Object.hasOwn(STEPS, job.presentation.nextAction?.code) && Object.hasOwn(ACTORS, job.presentation.nextAction?.actor)
    && Object.hasOwn(MODES, job.presentation.startMode) && Object.hasOwn(SLOTS, job.presentation.schedule?.state));
  const job = candidates.find(row => row.presentation.phase === 'action_required')
    || candidates.find(row => row.presentation.phase === 'automatic_queue');
  if (!job) return null;
  const { schedule, startMode, nextAction } = job.presentation;
  const slot = schedule.state === 'expired' && !job.reservation ? 'fenêtre de départ expirée' : SLOTS[schedule.state];
  const text = `Demande ${job.id.slice(0, 8)} (${slot}, ${MODES[startMode]}) · ${ACTORS[nextAction.actor]} — ${STEPS[nextAction.code]}.`;
  return { id: job.id, presentation: job.presentation, text };
}

export function createWorkQueueClient({ baseUrl, fetchImpl = fetch } = {}) {
  return async body => {
    if (!baseUrl) throw new Error('Canonical Core URL required');
    const response = await fetchImpl(new URL('/api/consumers/nestor/v1/work-queue', baseUrl), {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(15000),
      headers: { 'content-type': 'application/json' }, body: JSON.stringify(body)
    });
    const answer = await response.json();
    if (!response.ok || answer.ok === false || answer.status !== 'success' || !answer.data) {
      throw new Error(answer.message || 'Core queue unavailable; read the same request before retrying');
    }
    return answer.data;
  };
}
export function registerWorkQueue(api, { fetchImpl = fetch } = {}) {
  const runs = new Map();
  const key = (context, id) => `${context.sessionKey}:${id}`;
  api.on?.('before_tool_call', (event, context) => {
    if (event.toolName !== 'work_queue' || !(event.runId || context.runId) || !event.toolCallId || !context.sessionKey) return;
    runs.set(key(context, event.toolCallId), event.runId || context.runId);
    if (runs.size > 1000) runs.delete(runs.keys().next().value);
  });
  api.on?.('after_tool_call', (event, context) => { if (event.toolName === 'work_queue') runs.delete(key(context, event.toolCallId)); });
  const call = createWorkQueueClient({ baseUrl: api.pluginConfig?.agentxUrl, fetchImpl });
  api.registerTool(context => {
    const owner = privateOwnerContext(context, api.config);
    const briefing = configuredJobContext(context, api.pluginConfig?.briefingSessionKeys);
    if (!owner && !briefing) return null;
    return { name: 'work_queue', label: 'Heavy Work Queue',
      description: 'Read Core heavy-work requests and complete status counts, exact execution receipts and pending result notifications. Use summary.counts before pagination: automatic_queue waits for an accepted automatic start; action_required needs the actor/action in presentation.nextAction. Reservations are a separate scheduling dimension. Counts describe queue requests, not distinct tasks or live model activity. request records an explicitly requested batch, profiler, image or coding check for an operator to plan and run; it starts nothing. Give explicit hosts, duration and any owner start window. Personal errands belong in personal tasks; implementation work belongs in Pipeline. show reads active or archived work by id. cancel affects only unstarted work. acknowledge only after presenting that exact notification to the owner. Never retry an uncertain launch or claim completion without its receipt. No shell, scheduling administration or execution grant.',
      parameters: { type: 'object', properties: {
        action: { type: 'string', enum: owner ? ['list', 'show', 'request', 'cancel', 'notifications', 'acknowledge'] : ['list', 'show', 'notifications'] },
        id: { type: 'string', maxLength: 100 }, offset: { type: 'integer', minimum: 0 }, limit: { type: 'integer', minimum: 1, maximum: 50 },
        expectedRevision: { type: 'integer', minimum: 0 },
        title: { type: 'string', minLength: 1, maxLength: 240 },
        kind: { type: 'string', enum: ['benchmark', 'profiler', 'image', 'diagnostic', 'other'] },
        hosts: { type: 'array', minItems: 1, maxItems: 10, items: { type: 'string', maxLength: 200 } },
        estimatedMinutes: { type: 'integer', minimum: 1, maximum: 10080 },
        notBefore: { type: 'string', maxLength: 40 }, startBefore: { type: 'string', maxLength: 40 },
        taskId: { type: 'string', maxLength: 500 }, issueUrl: { type: 'string', maxLength: 500 }
      }, required: ['action'], additionalProperties: false },
      async execute(id, params) {
        if (!owner && !['list', 'show', 'notifications'].includes(params.action)) throw new Error('Briefing context holds read-only queue access');
        let body = { ...params };
        if (params.action === 'request') {
          const runId = context.runId || runs.get(key(context, id));
          if (!runId || !id || !context.sessionKey) throw new Error('Native run and tool-call identity required to enqueue');
          const requestKey = 'nestor:' + createHash('sha256').update(JSON.stringify([context.sessionKey, runId, id])).digest('hex');
          const request = { key: requestKey, title: params.title, kind: params.kind, hosts: params.hosts,
            estimatedMinutes: params.estimatedMinutes, source: { type: 'nestor', ref: context.sessionKey } };
          for (const field of ['notBefore', 'startBefore']) if (params[field] !== undefined) request[field] = params[field];
          for (const field of ['taskId', 'issueUrl']) if (params[field] !== undefined) request.source[field] = params[field];
          body = { action: 'request', request };
        }
        const result = await call(body);
        return { content: [{ type: 'text', text: JSON.stringify(result) }], details: result };
      }
    };
  }, { name: 'work_queue', optional: true });
}
