'use strict';

const { autoStartable } = require('./heavyWorkQueueCapabilities');
const PHASES = ['automatic_queue', 'action_required', 'dispatching', 'running', 'uncertain', 'finished', 'unknown'];
const TERMINAL = ['completed', 'failed', 'cancelled'];
const instant = value => value == null ? null : Date.parse(value);

function schedule(job, now) {
  const start = instant(job.reservation?.start), end = instant(job.reservation?.end);
  const notBefore = instant(job.notBefore), startBefore = instant(job.startBefore);
  if ([notBefore, startBefore].some(value => value !== null && !Number.isFinite(value))
    || (job.reservation && (!Number.isFinite(start) || !Number.isFinite(end) || end <= start))
    || (job.state === 'reserved' && !job.reservation)) return { state: 'invalid' };
  if ((startBefore !== null && now >= startBefore) || (end !== null && now >= end)) return { state: 'expired' };
  if (!job.reservation) return { state: 'unreserved' };
  return { state: now < Math.max(start, notBefore ?? -Infinity) ? 'upcoming' : 'open' };
}

/** Observation only: never probes an executor, grants authority or writes state. */
function presentation(job, { now = Date.now() } = {}) {
  const slot = schedule(job, now);
  const supported = autoStartable(job);
  const nativeImage = job.kind === 'image' && job.executor?.mode === 'image-operation';
  const automatic = nativeImage || (supported && job.reservation?.autoStart === true);
  const editable = ['requested', 'reserved'].includes(job.state);
  const base = {
    schema: 'agentx.heavy-work-presentation/v1', observedAt: new Date(now).toISOString(),
    authority: 'core.heavy-work-queue', authorization: 'not_granted_by_projection',
    startMode: automatic ? 'automatic' : job.executor ? 'manual' : 'unconfigured',
    schedule: slot,
    capabilities: { configureAutoStart: supported && editable,
      runNow: supported && job.state === 'reserved' && slot.state === 'open' },
  };
  const describe = (phase, label, code, actor, detail) => ({ ...base, phase, label, nextAction: { code, actor, detail } });
  if (TERMINAL.includes(job.state)) return describe('finished',
    { completed: 'Travail terminé', failed: 'Échec enregistré', cancelled: 'Demande annulée' }[job.state], 'inspect_result', 'none',
    'Inspect the recorded outcome and release evidence. This does not close the linked task or issue.');
  if (job.state === 'uncertain') return describe('uncertain', 'Résultat incertain', 'reconcile_original', 'operator',
    'Reconcile this exact request through its native owner. Do not launch a replacement or infer resource release.');
  if (job.state === 'dispatching') return describe('dispatching', 'Acheminement enregistré', 'observe_dispatch', 'native_executor',
    'Dispatch is recorded; executor start is not yet confirmed. Observe the original request and its receipts.');
  if (job.state === 'running') return describe('running', 'Exécution enregistrée', 'observe_result', 'native_executor',
    'Execution is recorded. Observe the existing executor result and release receipt; current activity has not been probed.');
  if (!editable) return describe('unknown', 'État à vérifier', 'inspect_state', 'operator',
    'Inspect the authoritative record; this state has no supported execution interpretation.');
  if (slot.state === 'invalid') return describe('action_required', 'En attente d’action', 'review_schedule', 'operator',
    'Review the missing or invalid execution window before planning or starting work.');
  if (slot.state === 'expired') return describe('action_required', 'En attente d’action', 'review_window', 'operator',
    'The start window or reservation has expired. Review the original intent and permitted window; it will not start automatically.');
  if (!job.executor) return describe('action_required', 'En attente d’action', 'prepare_executor', 'operator',
    'Prepare a reviewed executor request linked to this planning proposal. The proposal itself cannot start.');
  if (automatic && instant(job.notBefore) > now) return describe('automatic_queue', 'En file automatique', 'wait_not_before', 'core',
    'The accepted automatic start waits for its earliest permitted time, then native admission. No operator action is currently indicated.');
  if (automatic) return describe('automatic_queue', 'En file automatique',
    slot.state === 'upcoming' ? 'wait_slot' : 'await_native_admission', 'core',
    slot.state === 'upcoming' ? 'Starts automatically at its time, subject to native admission and the approved scope.'
      : 'Core will attempt the accepted automatic start within its permitted window. Resource availability and native admission still apply.');
  if (job.state === 'requested') return describe('action_required', 'En attente d’action', 'plan_slot', 'operator',
    'Plan a slot and choose the supported start mode. Free resources alone do not start this request.');
  return describe('action_required', 'En attente d’action', supported ? 'run_in_slot' : 'use_native_executor', 'operator',
    supported ? 'Waits for you: use Run now during its slot; native checks and approval still apply.'
      : 'Started by its own executor after the operator follows its approval and launch protocol.');
}

function project(job, options) { return { ...job, presentation: presentation(job, options) }; }

/** Mutually exclusive phase counts plus independent reservation counts. */
function summarize(jobs, { now = Date.now() } = {}) {
  const counts = Object.fromEntries(PHASES.map(phase => [phase, 0]));
  const reservations = { total: 0, upcoming: 0, open: 0, expired: 0, invalid: 0 };
  for (const job of jobs) {
    const view = presentation(job, { now });
    counts[view.phase] += 1;
    if (job.state === 'reserved') {
      reservations.total += 1;
      if (Object.hasOwn(reservations, view.schedule.state)) reservations[view.schedule.state] += 1;
    }
  }
  return { schema: 'agentx.heavy-work-summary/v1', observedAt: new Date(now).toISOString(),
    total: jobs.length, active: jobs.length - counts.finished, counts, reservations };
}

module.exports = { presentation, project, summarize };
