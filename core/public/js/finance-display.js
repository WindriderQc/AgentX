'use strict';

// Shared presentation only: Core supplies all coverage decisions and measures.
(function financeDisplay(root) {
  function money(cents) {
    if (!Number.isSafeInteger(cents)) return '—';
    const abs = Math.abs(cents);
    return `${cents < 0 ? '-' : ''}${String(Math.trunc(abs / 100)).replace(/\B(?=(\d{3})+(?!\d))/g, ' ')},${String(abs % 100).padStart(2, '0')} $`;
  }
  const dollars = cents => Number.isSafeInteger(cents) ? cents / 100 : null;
  const coverageLabel = coverage => ({ covered: 'Période couverte', partial: 'Période partielle',
    unknown: 'Couverture à confirmer', unavailable: 'Couverture indisponible' })[coverage?.status] || 'Couverture indisponible';
  function coverageText(coverage) {
    const reasons = coverage?.reasons || [];
    return [coverageLabel(coverage), coverage?.period ? `${coverage.period.from} → ${coverage.period.to}` : '',
      reasons.some(item => item.code === 'account_inventory_unconfirmed') ? 'Liste des comptes attendus à confirmer.' : '',
      reasons.some(item => item.code === 'missing_account_days') ? 'Des jours manquent pour les comptes attendus.' : '',
      reasons.some(item => item.code === 'statements_need_review') ? 'Des relevés restent à vérifier.' : '',
      coverage?.dataAsOf ? `Sources jusqu’au ${coverage.dataAsOf}${coverage.freshness?.stale ? ' · sources anciennes' : ''}` : 'Date commune des sources indisponible.']
      .filter(Boolean).join(' · ');
  }
  const monthLabel = row => row.complete === true ? '' : row.coverage?.fullMonth === false
    ? 'Fraction de mois sélectionnée' : coverageLabel(row.coverage);
  const api = { money, dollars, coverageText, coverageLabel, monthLabel };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.AgentXFinanceDisplay = api;
}(typeof window === 'undefined' ? globalThis : window));
