'use strict';

// Core supplies both the value and its denominator. Display text travels with
// the measure so a runtime need not reconstruct units or a supposedly full year.
function money(cents) {
  if (!Number.isSafeInteger(cents)) return null;
  const abs = Math.abs(cents);
  return `${cents < 0 ? '-' : ''}${String(Math.trunc(abs / 100)).replace(/\B(?=(\d{3})+(?!\d))/g, ' ')},${String(abs % 100).padStart(2, '0')} $`;
}
function monthlyAverage(totalCents, months) {
  const included = [...months];
  const available = included.length > 0 && Number.isSafeInteger(totalCents);
  const amountCents = available ? Math.round(totalCents / included.length) : null;
  return { kind: 'monthly_average', unit: 'cents/month', amountCents, totalCents: available ? totalCents : null,
    months: included, monthCount: included.length, display: amountCents === null ? null : `${money(amountCents)}/mois`,
    scopeText: available
      ? `Moyenne mensuelle sur ${included.length} mois couverts (${included.join(', ')}).`
      : included.length ? 'Moyenne mensuelle indisponible : le total ne tient pas en cents entiers fiables.'
        : 'Moyenne mensuelle indisponible : aucun mois entier admissible.' };
}
function periodTotal(amountCents, period) {
  return { kind: 'period_total', unit: 'cents', amountCents, period,
    display: money(amountCents), scopeText: period ? `Total enregistré du ${period.from} au ${period.to}.` : 'Période indisponible.' };
}
function monthlyChange(recent, previous) {
  const amountCents = recent.amountCents === null || previous.amountCents === null ? null : recent.amountCents - previous.amountCents;
  return { kind: 'monthly_average_change', unit: 'cents/month', amountCents,
    recentMonths: recent.months, previousMonths: previous.months,
    display: amountCents === null ? null : `${money(amountCents)}/mois`,
    scopeText: amountCents === null ? 'Comparaison indisponible : une fenêtre ne contient aucun mois admissible.'
      : `Écart entre deux moyennes mensuelles (${recent.monthCount} et ${previous.monthCount} mois couverts).` };
}
module.exports = { money, monthlyAverage, periodTotal, monthlyChange };
