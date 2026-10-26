'use strict';

/**
 * Public scoreboard projection.
 *
 * Turns Benchmark's private API payloads into the files a public site reads.
 * Every published field is copied by name (allow-list); nothing is passed
 * through wholesale. Host URLs become the machine names of the instance's host
 * registry. A final scan refuses any payload that still carries a network
 * address, URL or port.
 */

const crypto = require('crypto');

const SCHEMA = 'agentx.public-scoreboard/v1';
const UNLISTED_HOST = 'unlisted host';
const CATEGORY_KEY = /^[a-z][a-z0-9_-]{0,31}$/;
const ENUM_TEXT = /^[a-z][a-z0-9_-]{0,47}$/;
const MAX_TEXT = 160;

// Anything that can locate a machine on a network. Model tags such as
// `qwen3:27b` are not ports: a port is 4-5 digits not followed by a word char.
const LOCATION_PATTERNS = Object.freeze([
  { code: 'url', pattern: /[a-z][a-z0-9+.-]*:\/\//i },
  { code: 'ipv4', pattern: /(^|[^\d.])(\d{1,3}\.){3}\d{1,3}(?![\d.])/ },
  { code: 'ipv6', pattern: /\[[0-9a-f:.%]+\]|(^|[^\w:])([0-9a-f]{1,4}:){2,7}[0-9a-f]{0,4}(?![\w:])/i },
  { code: 'port', pattern: /:\d{4,5}(?![\w.])/ },
  { code: 'localhost', pattern: /\blocalhost\b/i },
  { code: 'unc-or-path', pattern: /\\\\|(^|\s)\/(srv|home|var|etc|opt|mnt|tmp|root|Users)\//i },
]);

function locationProblems(text, extraTokens = []) {
  const value = String(text);
  const lower = value.toLowerCase();
  const problems = LOCATION_PATTERNS.filter(({ pattern }) => pattern.test(value)).map(({ code }) => code);
  for (const token of extraTokens) {
    if (token && lower.includes(token)) problems.push('registered-address');
  }
  return problems;
}

/** Plain text safe for a public page: bounded, no markup, no location. */
function publicText(value, extraTokens = []) {
  if (typeof value !== 'string') return null;
  const text = value.replace(/[\u0000-\u001f\u007f<>]/g, '').trim().slice(0, MAX_TEXT);
  if (!text || locationProblems(text, extraTokens).length) return null;
  return text;
}

function enumText(value) {
  return typeof value === 'string' && ENUM_TEXT.test(value) ? value : null;
}

function round(value, digits = 2) {
  const n = Number(value);
  if (value === null || value === undefined || value === '' || !Number.isFinite(n)) return null;
  const factor = 10 ** digits;
  return Math.round(n * factor) / factor;
}

function count(value) {
  const n = Number(value);
  return Number.isSafeInteger(n) && n >= 0 ? n : 0;
}

function isoDate(value) {
  if (!value) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

function categoryMap(value, digits = 2) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const result = {};
  for (const [key, score] of Object.entries(value)) {
    if (!CATEGORY_KEY.test(key)) continue;
    const rounded = round(score, digits);
    if (rounded !== null) result[key] = rounded;
  }
  return result;
}

function slugBase(model) {
  return String(model).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80) || 'model';
}

/** Stable, collision-free slugs: two names that flatten alike get a hash suffix. */
function createSlugger() {
  const owners = new Map();
  return (model) => {
    const base = slugBase(model);
    const owner = owners.get(base);
    if (owner === undefined) { owners.set(base, model); return base; }
    if (owner === model) return base;
    const suffixed = `${base}-${crypto.createHash('sha256').update(model).digest('hex').slice(0, 6)}`;
    owners.set(suffixed, model);
    return suffixed;
  };
}

/** Case-insensitive glob list (`*` wildcard) of models kept off the public side. */
function createModelFilter(patterns = []) {
  const expressions = (Array.isArray(patterns) ? patterns : String(patterns || '').split(','))
    .map((pattern) => String(pattern).trim())
    .filter(Boolean)
    .map((pattern) => new RegExp(`^${pattern.split('*').map((part) => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`, 'i'));
  return (model) => expressions.some((expression) => expression.test(model));
}

function parseHostUrl(raw) {
  try {
    const parsed = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `http://${raw}`);
    const port = parsed.port || (parsed.protocol === 'https:' ? '443' : '80');
    return { hostname: parsed.hostname.toLowerCase(), port, key: `${parsed.hostname.toLowerCase()}:${port}` };
  } catch {
    return null;
  }
}

/**
 * Host resolver built from Benchmark's `/host-names` map ({ url: name }).
 *
 * - exact registered URL: its registry name;
 * - unregistered port on a registered machine: "<machine> (other instance)",
 *   the machine being the entry on Ollama's default port, else the shortest
 *   name on that address;
 * - an agent harness (`harness:<kind>:<id>`): "<kind> agent";
 * - a cloud target: its provider;
 * - anything else: "unlisted host".
 *
 * A registry name that itself looks like an address is never used.
 */
function createHostResolver(hostNames = {}) {
  const byKey = new Map();
  const byHostname = new Map();
  const forbiddenTokens = new Set();
  for (const [url, name] of Object.entries(hostNames || {})) {
    const parsed = parseHostUrl(url);
    if (!parsed) continue;
    if (parsed.hostname.includes('.') || parsed.hostname.includes(':')) forbiddenTokens.add(parsed.hostname);
    forbiddenTokens.add(parsed.key);
    const label = typeof name === 'string' ? name : '';
    byKey.set(parsed.key, label);
    const list = byHostname.get(parsed.hostname) || [];
    list.push({ port: parsed.port, label });
    byHostname.set(parsed.hostname, list);
  }
  const tokens = [...forbiddenTokens];
  const safe = (label) => publicText(label, tokens);

  function machineFor(hostname) {
    const entries = (byHostname.get(hostname) || []).filter((entry) => safe(entry.label));
    if (!entries.length) return null;
    const preferred = entries.find((entry) => entry.port === '11434')
      || [...entries].sort((a, b) => a.label.length - b.label.length || a.label.localeCompare(b.label))[0];
    return safe(preferred.label);
  }

  function resolve(host, { tier, provider } = {}) {
    const raw = typeof host === 'string' ? host.trim() : '';
    const harness = raw.match(/^harness:([a-z0-9-]{1,32})(?::|$)/i);
    if (harness) return `${harness[1].toLowerCase()} agent`;
    if (tier === 'cloud') return enumText(String(provider || '').toLowerCase()) || 'cloud';
    const parsed = raw ? parseHostUrl(raw) : null;
    if (!parsed) return UNLISTED_HOST;
    const exact = safe(byKey.get(parsed.key));
    if (exact) return exact;
    const machine = machineFor(parsed.hostname);
    return machine ? `${machine} (other instance)` : UNLISTED_HOST;
  }

  return { resolve, forbiddenTokens: tokens };
}

function projectLeaderboard(source, { resolver, slugFor, generatedAt, isExcluded = () => false }) {
  const rows = Array.isArray(source?.leaderboard) ? source.leaderboard : [];
  const dropped = { unrankable: 0, unsafeModel: 0, excluded: 0 };
  const ranked = [];
  for (const row of rows) {
    if (row?.rankable !== true || round(row.generalistScore) === null) { dropped.unrankable += 1; continue; }
    const model = publicText(row.model, resolver.forbiddenTokens);
    if (!model) { dropped.unsafeModel += 1; continue; }
    if (isExcluded(model)) { dropped.excluded += 1; continue; }
    const tier = row.tier === 'cloud' ? 'cloud' : 'local';
    ranked.push({
      slug: slugFor(model),
      model,
      hostAlias: resolver.resolve(row.host, { tier, provider: row.provider }),
      tier,
      residency: row.residency === 'cpu' || row.residency === 'gpu' ? row.residency : null,
      generalistScore: round(row.generalistScore),
      coverage: round(row.coverage),
      totalTests: count(row.totalTests),
      testedCategories: count(row.testedCategories),
      confidenceMargin: round(row.confidenceMargin),
      evidenceStatus: enumText(row.evidenceStatus),
      categoryAverages: categoryMap(row.categoryAverages),
      latestResultAt: isoDate(row.latestTimestamp),
    });
  }
  ranked.sort((a, b) => b.generalistScore - a.generalistScore || a.model.localeCompare(b.model));
  ranked.forEach((row, index) => { row.rank = index + 1; });
  return {
    payload: {
      schema: SCHEMA,
      generatedAt,
      axis: enumText(source?.axis),
      categoryWeights: categoryMap(source?.categoryWeights, 4),
      leaderboard: ranked,
    },
    dropped,
  };
}

function projectEfficiency(source, { resolver, slugFor, generatedAt, isExcluded = () => false }) {
  const entries = Array.isArray(source?.entries) ? source.entries : [];
  const dropped = { unranked: 0, unsafeModel: 0, excluded: 0 };
  const published = [];
  for (const entry of entries) {
    if ((entry?.rankStatus || 'ranked') !== 'ranked') { dropped.unranked += 1; continue; }
    const model = publicText(entry.model, resolver.forbiddenTokens);
    if (!model) { dropped.unsafeModel += 1; continue; }
    if (isExcluded(model)) { dropped.excluded += 1; continue; }
    published.push({
      slug: slugFor(model),
      model,
      hostAlias: resolver.resolve(entry.host),
      avgQuality: round(entry.avgQuality),
      avgTokPerSec: round(entry.avgTokPerSec, 1),
      avgLatencyMs: round(entry.avgLatency, 0),
      testCount: count(entry.testCount),
      efficiencyScore: round(entry.efficiencyScore),
      paretoOptimal: entry.paretoOptimal === true,
      categoryScores: categoryMap(entry.categoryScores),
    });
  }
  published.sort((a, b) => (b.efficiencyScore ?? -1) - (a.efficiencyScore ?? -1) || a.model.localeCompare(b.model));
  const frontier = published.filter((entry) => entry.paretoOptimal)
    .map(({ slug, model, hostAlias }) => ({ slug, model, hostAlias }));
  return {
    payload: {
      schema: SCHEMA,
      generatedAt,
      entries: published,
      frontier,
      meta: {
        totalModels: new Set(published.map((entry) => entry.model)).size,
        totalHosts: new Set(published.map((entry) => entry.hostAlias)).size,
        totalTests: published.reduce((sum, entry) => sum + entry.testCount, 0),
      },
    },
    dropped,
  };
}

function projectSummary(source, { leaderboard, efficiency, generatedAt, snapshotCount = 0 }) {
  const top = leaderboard.leaderboard[0] || null;
  const models = new Set([...leaderboard.leaderboard, ...efficiency.entries].map((row) => row.model));
  const hosts = new Set([...leaderboard.leaderboard, ...efficiency.entries].map((row) => row.hostAlias));
  return {
    schema: SCHEMA,
    generatedAt,
    status: models.size ? 'published' : 'empty',
    metrics: {
      models: models.size,
      hosts: hosts.size,
      tests: count(source?.total_tests),
      successfulTests: count(source?.successful),
      rankedEntries: leaderboard.leaderboard.length,
      snapshots: count(snapshotCount),
    },
    topModel: top ? { slug: top.slug, model: top.model, hostAlias: top.hostAlias, generalistScore: top.generalistScore } : null,
  };
}

function buildModelCards({ leaderboard, efficiency, generatedAt }) {
  const cards = new Map();
  const cardFor = (row) => {
    if (!cards.has(row.slug)) {
      cards.set(row.slug, { slug: row.slug, name: row.model, model: row.model, generatedAt, results: [], efficiency: [] });
    }
    return cards.get(row.slug);
  };
  for (const row of leaderboard.leaderboard) {
    const { slug, model, ...result } = row;
    cardFor(row).results.push(result);
  }
  for (const entry of efficiency.entries) {
    const { slug, model, ...result } = entry;
    cardFor(entry).efficiency.push(result);
  }
  const models = [...cards.values()].map((card) => {
    const best = card.results[0] || null;
    const totalTests = card.results.reduce((sum, result) => sum + result.totalTests, 0)
      || card.efficiency.reduce((sum, result) => sum + result.testCount, 0);
    const summary = best
      ? `Rank ${best.rank} with a generalist score of ${best.generalistScore} on ${best.hostAlias} (${best.totalTests} tests).`
      : `Measured for efficiency only (${totalTests} tests).`;
    return {
      ...card,
      summary,
      generalistScore: best ? best.generalistScore : null,
      bestRank: best ? best.rank : null,
      bestHost: best ? best.hostAlias : null,
      totalTests,
    };
  });
  models.sort((a, b) => (a.bestRank ?? Infinity) - (b.bestRank ?? Infinity) || a.model.localeCompare(b.model));
  return { schema: SCHEMA, generatedAt, models };
}

/** Hash of the published content, without timestamps, to detect real changes. */
function contentHash({ leaderboard, efficiency }) {
  const body = JSON.stringify({
    leaderboard: leaderboard.leaderboard,
    weights: leaderboard.categoryWeights,
    efficiency: efficiency.entries,
  });
  return crypto.createHash('sha256').update(body).digest('hex');
}

/**
 * Every string and key of the payload, scanned for network locations.
 * Returns [{ path, problems }]; an empty list means the payload may leave.
 */
function findPrivateLocations(value, extraTokens = [], path = '$') {
  const found = [];
  const tokens = extraTokens.map((token) => String(token).toLowerCase()).filter(Boolean);
  const visit = (node, at) => {
    if (typeof node === 'string') {
      const problems = locationProblems(node, tokens);
      if (problems.length) found.push({ path: at, problems });
    } else if (Array.isArray(node)) {
      node.forEach((child, index) => visit(child, `${at}[${index}]`));
    } else if (node && typeof node === 'object') {
      for (const [key, child] of Object.entries(node)) {
        const problems = locationProblems(key, tokens);
        if (problems.length) found.push({ path: `${at}.${key}`, problems: problems.map((p) => `key:${p}`) });
        visit(child, `${at}.${key}`);
      }
    }
  };
  visit(value, path);
  return found;
}

class UnsafePublicationError extends Error {
  constructor(findings) {
    super(`Refusing to publish: ${findings.length} value(s) still locate a machine (${findings.slice(0, 5).map((f) => f.path).join(', ')})`);
    this.code = 'PUBLIC_PAYLOAD_UNSAFE';
    this.findings = findings;
  }
}

function assertPublicSafe(files, extraTokens = []) {
  const findings = [];
  for (const [name, payload] of Object.entries(files)) {
    findings.push(...findPrivateLocations(payload, extraTokens, name));
  }
  if (findings.length) throw new UnsafePublicationError(findings);
}

/** All public payloads from the four Benchmark responses. */
function buildPublication({ summary, leaderboard, efficiency, hostNames }, { generatedAt, snapshotCount = 0, excludeModels = [] } = {}) {
  const at = isoDate(generatedAt) || new Date().toISOString();
  const resolver = createHostResolver(hostNames);
  const slugFor = createSlugger();
  const isExcluded = createModelFilter(excludeModels);
  const board = projectLeaderboard(leaderboard, { resolver, slugFor, generatedAt: at, isExcluded });
  const map = projectEfficiency(efficiency, { resolver, slugFor, generatedAt: at, isExcluded });
  const files = {
    'summary.json': projectSummary(summary, { leaderboard: board.payload, efficiency: map.payload, generatedAt: at, snapshotCount }),
    'leaderboard.json': board.payload,
    'efficiency.json': map.payload,
    'model-cards.json': buildModelCards({ leaderboard: board.payload, efficiency: map.payload, generatedAt: at }),
  };
  assertPublicSafe(files, resolver.forbiddenTokens);
  return {
    files,
    hash: contentHash({ leaderboard: board.payload, efficiency: map.payload }),
    forbiddenTokens: resolver.forbiddenTokens,
    dropped: { leaderboard: board.dropped, efficiency: map.dropped },
  };
}

module.exports = {
  SCHEMA,
  UNLISTED_HOST,
  UnsafePublicationError,
  assertPublicSafe,
  buildModelCards,
  buildPublication,
  contentHash,
  createHostResolver,
  createModelFilter,
  createSlugger,
  findPrivateLocations,
  projectEfficiency,
  projectLeaderboard,
  projectSummary,
  publicText,
};
