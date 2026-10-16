'use strict';

// Minimal finance summary for the daily brief of another surface. It carries labels and
// counts only: no amount, no account number, no path. Labels keep no digits, so an account
// number or an amount cannot leak through a deadline name.

const FinanceDocumentLink = require('../../../models/FinanceDocumentLink');
const { evaluate } = require('./financeAlerts');
const { coverage } = require('./financeQueryService');

const MAX_LABELS = 3;

const label = (value) => String(value || '').replace(/\d+/g, '').replace(/[$·]/g, ' ').replace(/\s+/g, ' ').trim();

// A series named by its issuer, without its last four digits.
const seriesLabel = (value) => label(String(value || '').replace(/\s*···.*$/, ''));

function phrase(days) {
  if (days < 0) return 'en retard';
  if (days === 0) return "à payer aujourd'hui";
  if (days === 1) return 'à payer demain';
  return `à payer dans ${days} jours`;
}

async function summary({ now = new Date() } = {}) {
  const found = await evaluate({ now });
  const overdue = found.filter((alert) => alert.kind === 'deadline_overdue').map((alert) => label(alert.facts.label)).filter(Boolean);
  const soon = found.filter((alert) => ['deadline_due', 'deadline_upcoming'].includes(alert.kind))
    .map((alert) => ({ text: label(alert.facts.label), days: alert.facts.daysUntil })).filter((item) => item.text);
  const late = [...new Set(found.filter((alert) => alert.kind === 'stale_data').map((alert) => seriesLabel(alert.facts.label)).filter(Boolean))];
  const { series } = await coverage({ ledger: 'perso' });
  const missing = series.reduce((sum, item) => sum + item.missing.length, 0);
  const proposals = await FinanceDocumentLink.countDocuments({ status: 'proposed', 'document.ledger': { $ne: 'corp' } });

  const parts = [];
  for (const name of overdue.slice(0, MAX_LABELS)) parts.push(`${name} en retard`);
  for (const item of soon.slice(0, MAX_LABELS)) parts.push(`${item.text} ${phrase(item.days)}`);
  if (late.length) parts.push(`relevés en retard : ${late.slice(0, MAX_LABELS).join(', ')}`);
  if (missing) parts.push(`${missing} relevé${missing > 1 ? 's' : ''} attendu${missing > 1 ? 's' : ''}`);
  if (proposals) parts.push(`${proposals} lien${proposals > 1 ? 's' : ''} à confirmer`);
  return {
    summary: parts.length ? `Finances : ${parts.join(' · ')}` : null,
    counts: { overdue: overdue.length, dueSoon: soon.length, lateSeries: late.length, missingStatements: missing, proposals }
  };
}

module.exports = { summary, label, seriesLabel };
