'use strict';

const descriptions = Object.freeze({
  inference_active: ['Une autre demande utilise les ressources de Nestor.', 'Another request is using the resources Nestor needs.'],
  workload_reserved: ['Un travail a réservé les ressources de Nestor.', 'A job has reserved the resources Nestor needs.'],
  maintenance_active: ['Une maintenance retient les ressources de Nestor.', 'Maintenance is holding the resources Nestor needs.'],
  host_down: ['Core n’a pas pu joindre Nestor. Son activité n’est pas connue.', 'Core could not reach Nestor. Its activity is unknown.'],
  unknown: ['Nestor est indisponible. La raison n’est pas vérifiée.', 'Nestor is unavailable. The reason has not been verified.']
});
const categoryOf = value => typeof value === 'string' && Object.hasOwn(descriptions, value) ? value : 'unknown';
function categoryFor({ occupied, cause, holderType, reason }) {
  if (occupied) {
    if (holderType === 'inference' && ['inference_active', 'inference_residency_active'].includes(cause)) return 'inference_active';
    if (holderType === 'workload' && cause === 'workload_reserved') return cause;
    if (holderType === 'maintenance' && cause === 'maintenance_active') return cause;
    return 'unknown';
  }
  return reason === 'host_down' ? 'host_down' : 'unknown';
}
function description(value, language = 'fr') {
  return descriptions[categoryOf(value)][language === 'en' ? 1 : 0];
}

module.exports = { categoryFor, categoryOf, description };
