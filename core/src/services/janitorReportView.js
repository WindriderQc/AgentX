'use strict';

/**
 * Nestor's read of the latest Janitor duplicate report, with the DiskX link
 * that shows it in the 3D city.
 *
 * It reads the shared-drive strategy report Data last stored (and, for a named
 * group, that group's row) through GET requests only, projected by the Data
 * Toolbox's own projection. It never scans, runs, generates, approves, moves or
 * deletes anything. Counts and logical byte totals only: no file path leaves
 * this module. Two facts travel with every answer: the report's survivor rule
 * says which copy it would keep, it does not authorize any action; and the
 * savings are logical bytes, the physical space freed is not measured.
 */

const STRATEGY_ROUTE = '/api/v1/janitor/profiles/shared-drive/strategy/latest';
const GROUPS_ROUTE = `${STRATEGY_ROUTE}/groups`;
const REQUEST_TIMEOUT_MS = 6000;
const SHA256 = /^[0-9a-f]{64}$/;
const DISKX_PATH = '/diskx';

const SURVIVOR_WORDS = Object.freeze({
  canonical_active: 'la copie active de l’emplacement canonique',
  newest: 'la copie la plus récente',
  oldest: 'la copie la plus ancienne'
});

const NOTES = Object.freeze({
  survivorRule: 'La règle de conservation du rapport indique quelle copie il garderait ; ce n’est pas une autorisation : rien n’est supprimé ni déplacé sans une approbation explicite par action.',
  logicalBytes: 'Les économies sont des octets logiques ; l’espace physique libéré n’est pas mesuré.'
});

function invalid(message) {
  return Object.assign(new Error(message), { code: 'INVALID_ARGUMENTS' });
}

function unavailable(message) {
  return Object.assign(new Error(message), { code: 'DATA_UNAVAILABLE' });
}

function sizeLabel(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) return null;
  const units = ['o', 'Ko', 'Mo', 'Go', 'To', 'Po'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit += 1; }
  const text = unit === 0 || value >= 100 ? String(Math.round(value)) : value.toFixed(value >= 10 ? 1 : 2);
  return `${text.replace('.', ',')} ${units[unit]}`;
}

function ageLabel(ms) {
  const minutes = Math.max(0, Math.round(ms / 60000));
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.round(minutes / 60);
  return hours < 48 ? `${hours} h` : `${Math.round(hours / 24)} jours`;
}

const count = (value) => (value !== null && value !== '' && Number.isFinite(Number(value)) && Number(value) >= 0 ? Number(value) : null);

function checkArguments(args) {
  if (!args || typeof args !== 'object' || Array.isArray(args)) throw invalid('arguments must be an object');
  const unknown = Object.keys(args).filter((key) => key !== 'group');
  if (unknown.length) throw invalid(`unknown argument: ${unknown[0].slice(0, 40)}`);
  if (args.group === undefined || args.group === null || args.group === '') return {};
  const group = String(args.group).toLowerCase();
  if (!SHA256.test(group)) throw invalid('group must be one SHA-256 (64 hexadecimal characters)');
  return { group };
}

/**
 * The DiskX page link. CORE_PUBLIC_URL is the browser-facing Core address on
 * the private network; without a usable one the link stays a Core path.
 */
function diskxLink({ group } = {}, env = process.env) {
  const query = new URLSearchParams({ janitor: 'latest', ...(group ? { group } : {}) }).toString();
  const relative = `${DISKX_PATH}?${query}`;
  try {
    const base = new URL(String(env.CORE_PUBLIC_URL || '').trim());
    if (!['http:', 'https:'].includes(base.protocol) || base.username || base.password) return relative;
    return new URL(relative, base.origin + base.pathname.replace(/\/*$/, '/')).href;
  } catch {
    return relative;
  }
}

async function readData(fetchData, route, query = '') {
  let answer;
  try { answer = await fetchData(route, { query, timeoutMs: REQUEST_TIMEOUT_MS }); }
  catch (error) {
    throw unavailable(error?.name === 'TimeoutError' ? 'Data did not answer in time' : 'Data is unreachable');
  }
  return answer;
}

function groupView(page, sha256) {
  const row = (Array.isArray(page?.groups) ? page.groups : []).find((group) => group?.sha256 === sha256);
  if (!row) return { sha256, found: false };
  const copies = count(row.count) ?? (Array.isArray(row.files) ? row.files.length : null);
  const savings = count(row.provenSavingsBytes);
  return { sha256, found: true, copies, provenSavingsBytes: savings, provenSavingsLabel: sizeLabel(savings) };
}

function sentence({ view, group }) {
  if (!view.available) return 'Aucun rapport Janitor n’est encore disponible.';
  const s = view.counts;
  const age = view.ageMs === null ? 'date inconnue' : `il y a ${ageLabel(view.ageMs)}`;
  const parts = [
    `Dernier rapport Janitor (${view.status}, ${age}) : ${s.verifiedGroups} groupes de doublons vérifiés par SHA-256, ${s.verifiedFiles} fichiers, ${view.provenSavingsLabel || 'économie inconnue'} d’économie logique prouvée.`,
    `${s.executableActions} action(s) exécutable(s), ${s.decisionsRequired} décision(s) de politique en attente.`,
    `Règle de conservation : ${view.survivorRuleLabel}, ce n’est pas une autorisation. Octets logiques ; l’espace physique libéré n’est pas mesuré.`
  ];
  if (group) {
    parts.push(group.found
      ? `Groupe ${group.sha256.slice(0, 12)}… : ${group.copies ?? '?'} copies, ${group.provenSavingsLabel || 'économie inconnue'} logiques.`
      : `Le groupe ${group.sha256.slice(0, 12)}… n’est pas dans le dernier rapport.`);
  }
  return parts.join(' ');
}

/** The latest strategy report as counts, logical savings and the DiskX link. */
async function readJanitorReportView(args = {}, deps = {}) {
  const input = checkArguments(args);
  const fetchData = deps.fetchData || require('./dataServiceClient').fetchData;
  const project = deps.projectJanitorStrategy || require('../../surfaces/data-toolbox').projectJanitorStrategy;
  const now = deps.now ? deps.now() : new Date();

  const { response, body } = await readData(fetchData, STRATEGY_ROUTE);
  const notFound = response.status === 404;
  if (!response.ok && !notFound) throw unavailable(`Data answered ${response.status}`);
  const report = project(notFound ? {} : body);
  const generated = report.generatedAt ? new Date(report.generatedAt).getTime() : NaN;
  const provenSavings = count(report.summary.provenSavingsBytes);

  const view = {
    available: !notFound && report.status !== 'unavailable',
    status: report.status,
    generatedAt: Number.isFinite(generated) ? new Date(generated).toISOString() : null,
    ageMs: Number.isFinite(generated) ? Math.max(0, now.getTime() - generated) : null,
    counts: {
      verifiedGroups: report.summary.verifiedGroups,
      verifiedFiles: report.summary.verifiedFiles,
      candidateGroups: report.summary.candidateGroups,
      executableActions: report.summary.executableActions,
      decisionsRequired: report.summary.decisionsRequired,
      sharedDriveMutations: report.summary.sharedDriveMutations
    },
    provenSavingsBytes: provenSavings,
    provenSavingsLabel: sizeLabel(provenSavings),
    bytesKind: 'logical',
    physicalSpaceMeasured: false,
    survivorRule: report.policy.duplicateSurvivor,
    survivorRuleLabel: SURVIVOR_WORDS[report.policy.duplicateSurvivor] || 'non choisie',
    survivorRuleAuthorizes: false,
    maintenanceAuthorization: report.policy.maintenanceAuthorization
  };

  let group = null;
  if (input.group && view.available) {
    const page = await readData(fetchData, GROUPS_ROUTE, new URLSearchParams({ sha256: input.group }).toString());
    if (!page.response.ok) throw unavailable(`Data answered ${page.response.status}`);
    group = groupView(page.body?.data ?? page.body, input.group);
  }

  return {
    summary: sentence({ view, group }),
    ...view,
    ...(group ? { group } : {}),
    link: view.available ? diskxLink({ group: group?.found ? group.sha256 : undefined }, deps.env || process.env) : null,
    linkScope: 'private_network',
    notes: [NOTES.survivorRule, NOTES.logicalBytes],
    readOnly: true
  };
}

module.exports = { readJanitorReportView, diskxLink, checkArguments, NOTES };
