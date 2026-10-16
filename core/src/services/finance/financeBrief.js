'use strict';

// Minimal finance summary for the daily brief of another surface. It carries short
// labels and counts only. An amount, a long number or an account-like number never
// reaches the text: they are removed from every label before it is written.

const FinanceDocumentLink = require('../../../models/FinanceDocumentLink');
const { evaluate } = require('./financeAlerts');

const MAX_LABELS = 3;
const MAX_LABEL = 50;

// Amounts ("9 100,83 $", "1 271 $"), arrows between amounts ("500 → 550 $/mois"), long digit runs and
// four-digit runs that are not years. Short words and years such as "T2", "11 août" or "2027" stay.
const AMOUNT = /[\d][\d\s\u00a0.,]*\s*\$/g;
const ARROW = /\d[\d\s\u00a0.,]*→\s*/g;
const UNIT = /\/\s*mois/g;
const LONG_NUMBER = /\b\d{5,}\b/g;
const ACCOUNT_LIKE = /(?<!\d)(?!(?:19|20)\d\d(?!\d))\d{4}(?!\d)/g;

// Removes what must never reach the brief, then tidies the punctuation left behind.
function clean(text) {
  return String(text || '')
    .replace(AMOUNT, ' ').replace(/\$/g, ' ').replace(ARROW, ' ').replace(UNIT, ' ')
    .replace(LONG_NUMBER, ' ').replace(ACCOUNT_LIKE, ' ')
    .replace(/\s+/g, ' ').replace(/\s+([,;:])/g, '$1')
    .replace(/[\s,;:(–—-]+$/, '').trim();
}

// A short label from the owner's text: the part before a dash, a parenthesis or a colon, then at most
// MAX_LABEL characters cut on a word boundary. An explicit briefLabel from the plan wins over it.
function shortLabel(item) {
  if (item.briefLabel) return clean(item.briefLabel);
  const head = String(item.label || '').split(/\s[—–-]\s|\s\(|:/)[0];
  if (head.length <= MAX_LABEL) return clean(head);
  const cut = head.slice(0, MAX_LABEL + 1);
  return clean(cut.slice(0, cut.lastIndexOf(' ') > 0 ? cut.lastIndexOf(' ') : MAX_LABEL));
}

// A series named by its issuer, without its last four digits.
const seriesLabel = (value) => clean(String(value || '').replace(/\s*···.*$/, ''));

function phrase(days) {
  if (days < 0) return 'en retard';
  if (days === 0) return "à payer aujourd'hui";
  if (days === 1) return 'à payer demain';
  return `à payer dans ${days} jours`;
}

async function summary({ now = new Date() } = {}) {
  const found = await evaluate({ now });
  const overdue = found.filter((alert) => alert.kind === 'deadline_overdue').map((alert) => shortLabel(alert.facts))
    .filter(Boolean);
  const soon = found.filter((alert) => ['deadline_due', 'deadline_upcoming'].includes(alert.kind))
    .map((alert) => ({ text: shortLabel(alert.facts), days: alert.facts.daysUntil })).filter((item) => item.text);
  const late = [...new Set(found.filter((alert) => alert.kind === 'stale_data').map((alert) => seriesLabel(alert.facts.label))
    .filter(Boolean))];
  const { series } = await require('./financeQueryService').coverage({ ledger: 'perso' });
  const missing = series.reduce((sum, item) => sum + item.missing.length, 0);
  const proposals = await FinanceDocumentLink.countDocuments({ status: 'proposed', 'document.ledger': { $ne: 'corp' } });

  const parts = [];
  for (const name of overdue.slice(0, MAX_LABELS)) parts.push(`${name} en retard`);
  for (const item of soon.slice(0, MAX_LABELS)) parts.push(`${item.text} ${phrase(item.days)}`);
  if (late.length) parts.push(`relevés à déposer : ${late.slice(0, MAX_LABELS).join(', ')}`);
  if (proposals) parts.push(`${proposals} lien${proposals > 1 ? 's' : ''} à confirmer`);
  return {
    summary: parts.length ? `Finances : ${parts.join(' · ')}` : null,
    counts: { overdue: overdue.length, dueSoon: soon.length, lateSeries: late.length, missingStatements: missing, proposals }
  };
}

module.exports = { summary, clean, shortLabel, seriesLabel };
