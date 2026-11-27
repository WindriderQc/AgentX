'use strict';

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

function workQueueExample(job) {
  if (!job?.presentation || typeof job.id !== 'string' || !/^[a-z0-9-]+$/i.test(job.id)) return null;
  const { schedule, startMode, nextAction } = job.presentation;
  if (!Object.hasOwn(STEPS, nextAction?.code) || !Object.hasOwn(ACTORS, nextAction?.actor)
    || !Object.hasOwn(MODES, startMode) || !Object.hasOwn(SLOTS, schedule?.state)) return null;
  const slot = schedule.state === 'expired' && !job.reservation ? 'fenêtre de départ expirée' : SLOTS[schedule.state];
  const text = `Demande ${job.id.slice(0, 8)} (${slot}, ${MODES[startMode]}) · ${ACTORS[nextAction.actor]} — ${STEPS[nextAction.code]}.`;
  return { id: job.id, presentation: job.presentation, text };
}

module.exports = { workQueueExample };
