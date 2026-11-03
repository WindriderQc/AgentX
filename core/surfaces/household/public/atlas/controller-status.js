import { escape } from './ui.js';

export function controllerNotice(review) {
  const c = review.controller;
  if (!c) return '';
  let date = '';
  const stamp = Date.parse(c.reconciledAt || c.at);
  if (Number.isFinite(stamp)) date = new Intl.DateTimeFormat('fr-CA', {
    dateStyle: 'medium', timeStyle: 'short'
  }).format(new Date(stamp));
  const message = c.released
    ? c.queueState === 'failed'
      ? 'La dernière tranche a échoué et ses ressources ont été libérées. Les preuves doivent être examinées avant toute reprise.'
      : 'La dernière tranche est terminée et ses ressources ont été libérées. Cela ne termine pas la reconstruction de ton histoire.'
    : ['uncertain', 'source-error', 'failed'].includes(review.phase)
      ? 'La lecture est arrêtée pour vérification. Conserve les preuves avant de demander une reprise.'
      : !c.fresh ? 'Ce suivi est ancien. Aucune lecture en cours ne peut être confirmée.' : '';
  return `<p class="coverage-limit">${escape(message)}${date ? ` Dernier état enregistré : ${escape(date)}.` : ''}</p>`;
}
