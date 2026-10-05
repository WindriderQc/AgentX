#!/usr/bin/env node
'use strict';

/**
 * Environment catalog check.
 *
 * `shared/envCatalog.json` lists every environment variable an operator can set
 * for an AgentX instance: the ones docker-compose.yml forwards from the
 * instance env file (`${VAR}` / `${VAR:-default}`), and the ones service code
 * reads but compose does not forward (they only reach a container through the
 * instance override). This script scans both sources and compares them with
 * the catalog.
 *
 *   node scripts/env-catalog.cjs           check; exit 1 on drift
 *   node scripts/env-catalog.cjs --write   add skeleton entries for new variables
 *                                          and drop entries nothing uses any more
 *   node scripts/env-catalog.cjs --json    print the scan
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const CATALOG = path.join(ROOT, 'shared', 'envCatalog.json');
const COMPOSE = path.join(ROOT, 'docker-compose.yml');
const SERVICE_DIRS = Object.freeze({
  core: ['core/src', 'core/routes', 'core/integrations', 'core/surfaces', 'core/config', 'core/models', 'core/server.js'],
  benchmark: ['benchmark/src', 'benchmark/routes', 'benchmark/models', 'benchmark/server.js', 'benchmark/config'],
  rag: ['rag/src', 'rag/routes', 'rag/server.js', 'rag/config'],
  data: ['data/src', 'data/routes', 'data/controllers', 'data/services', 'data/server.js', 'data/config'],
});
// Set by the runtime or the platform, never by an operator.
const IGNORED = new Set(['NODE_ENV', 'HOME', 'PATH', 'PWD', 'HOSTNAME', 'TZ', 'JEST_WORKER_ID', 'CI', 'npm_package_version']);
const { SECRET_NAME } = require('../shared/envStatus');

/** Environment entries per compose service: { service: { VAR: rawValue } }. */
function parseCompose(text) {
  const services = {};
  let inServices = false;
  let service = null;
  let inEnv = false;
  for (const line of text.split(/\r?\n/)) {
    if (/^services:\s*$/.test(line)) { inServices = true; continue; }
    if (/^\S/.test(line)) { inServices = /^services:/.test(line); service = null; inEnv = false; continue; }
    if (!inServices) continue;
    const svc = line.match(/^ {2}([a-z][\w-]*):\s*$/);
    if (svc) { service = svc[1]; services[service] = services[service] || {}; inEnv = false; continue; }
    if (!service) continue;
    if (/^ {4}environment:\s*$/.test(line)) { inEnv = true; continue; }
    if (/^ {4}\S/.test(line)) { inEnv = false; continue; }
    if (!inEnv) continue;
    const kv = line.match(/^ {6}([A-Z][A-Z0-9_]*):\s*(.*)$/);
    if (kv) services[service][kv[1]] = kv[2].replace(/^["']|["']$/g, '');
  }
  return services;
}

/** `${HOST_VAR:-default}` inside a compose value, or null for a fixed value. */
function parseReference(raw) {
  const text = String(raw);
  const m = text.match(/\$\{([A-Z][A-Z0-9_]*)(?::?-([^}]*))?\}/);
  if (!m) return null;
  // A value that embeds the reference (`http://localhost:${CORE_PORT:-3080}`)
  // defaults to the whole template, not to the inner default.
  if (m[0] !== text.trim()) return { hostVar: m[1], default: text.trim() };
  return { hostVar: m[1], default: m[2] === undefined ? null : m[2].replace(/^["']|["']$/g, '') };
}

function walk(target, files = []) {
  if (!fs.existsSync(target)) return files;
  const stat = fs.statSync(target);
  if (stat.isFile()) {
    if (/\.(c?js|mjs)$/.test(target)) files.push(target);
    return files;
  }
  for (const name of fs.readdirSync(target)) {
    if (['node_modules', 'test', 'tests', '__tests__', 'public', 'fixtures'].includes(name)) continue;
    if (/\.test\.(c?js|mjs)$/.test(name)) continue;
    walk(path.join(target, name), files);
  }
  return files;
}

/** Variables each service's code reads: { service: Set<VAR> }. */
function scanCode(root = ROOT) {
  const result = {};
  const pattern = /process\.env(?:\.([A-Z][A-Z0-9_]*)|\[\s*['"]([A-Z][A-Z0-9_]*)['"]\s*\])/g;
  for (const [service, dirs] of Object.entries(SERVICE_DIRS)) {
    const vars = new Set();
    for (const dir of dirs) {
      for (const file of walk(path.join(root, dir))) {
        const text = fs.readFileSync(file, 'utf8');
        for (const m of text.matchAll(pattern)) {
          const name = m[1] || m[2];
          if (!IGNORED.has(name)) vars.add(name);
        }
      }
    }
    result[service] = vars;
  }
  return result;
}

/**
 * The operator-facing variables: { VAR: { services, forwarded, default, fixedIn } }.
 * A compose value with no `${...}` is fixed by the product, not configurable.
 */
function scan(root = ROOT) {
  const compose = parseCompose(fs.readFileSync(path.join(root, 'docker-compose.yml'), 'utf8'));
  const code = scanCode(root);
  const vars = {};
  const entry = (name) => (vars[name] = vars[name] || { services: new Set(), forwarded: false, default: null, fixedIn: new Set() });

  for (const [service, env] of Object.entries(compose)) {
    for (const [name, raw] of Object.entries(env)) {
      const ref = parseReference(raw);
      if (!ref) continue;
      const e = entry(name);
      e.services.add(service);
      e.forwarded = true;
      if (ref.default !== null && ref.default !== '') e.default = ref.default;
      if (ref.hostVar !== name) e.hostVar = ref.hostVar;
    }
  }
  for (const [service, names] of Object.entries(code)) {
    for (const name of names) {
      const fixed = compose[service] && compose[service][name] !== undefined && !parseReference(compose[service][name]);
      if (fixed) continue;
      entry(name).services.add(service);
    }
  }
  return Object.fromEntries(Object.entries(vars).sort(([a], [b]) => a.localeCompare(b)).map(([name, e]) => [name, {
    services: [...e.services].sort(),
    forwarded: e.forwarded,
    default: e.default,
    ...(e.hostVar ? { hostVar: e.hostVar } : {}),
  }]));
}

function guessCategory(name) {
  const rules = [
    [/^(OPENCLAW|HERMES|DSH|CODING|AGENTX_OPENCLAW|AGENTX_CODING|GITHUB)/, 'bridges'],
    [/(FALLBACK|ROUTE|ROUTER|ROUTING|GATE|PRIORITY|ADMISSION)/, 'routing'],
    [/(OLLAMA|HOST|MODEL|NUM_CTX|CONTEXT|PIN)/, 'inference'],
    [/(HOUSEHOLD|VOIX|VOICE|AVATAR|PSYX|FACE|KIDS)/, 'household'],
    [/^FINANCE/, 'finance'],
    [/(RAG|QDRANT|EMBED|MEMORY|VAULT|NOTE)/, 'memory'],
    [/(ALERT|WATCHDOG|TELEMETRY|LOG|METRIC)/, 'observability'],
    [/(BENCHMARK|JUDGE|PROFILER|PROBE|CAMPAIGN)/, 'benchmark'],
    [/(MONGO|DB_|DATABASE|BACKUP)/, 'storage'],
    [/(URL|PORT|BASE|PUBLIC)/, 'network'],
  ];
  const hit = rules.find(([re]) => re.test(name));
  return hit ? hit[1] : 'other';
}

function readCatalog(file = CATALOG) {
  return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : { version: 1, variables: {} };
}

/** Differences between the scan and the catalog. */
function compare(scanned, catalog) {
  const listed = catalog.variables || {};
  const missing = Object.keys(scanned).filter((name) => !listed[name]);
  const stale = Object.keys(listed).filter((name) => !scanned[name]);
  const undocumented = Object.entries(listed)
    .filter(([name, e]) => scanned[name] && scanned[name].forwarded && !String(e.description || '').trim())
    .map(([name]) => name);
  const mismatched = Object.entries(listed)
    .filter(([name, e]) => scanned[name] && (
      JSON.stringify(e.services) !== JSON.stringify(scanned[name].services)
      || Boolean(e.forwarded) !== scanned[name].forwarded
      || (scanned[name].forwarded && (e.default ?? null) !== scanned[name].default)))
    .map(([name]) => name);
  return { missing, stale, undocumented, mismatched };
}

function write(scanned, catalog) {
  const next = { version: 1, variables: {} };
  for (const [name, s] of Object.entries(scanned)) {
    const old = (catalog.variables || {})[name] || {};
    next.variables[name] = {
      services: s.services,
      forwarded: s.forwarded,
      default: s.forwarded ? s.default : (old.default ?? null),
      ...(s.hostVar ? { hostVar: s.hostVar } : {}),
      category: old.category || guessCategory(name),
      secret: old.secret ?? SECRET_NAME.test(name),
      description: old.description || '',
      ...(old.fallback ? { fallback: old.fallback } : {}),
    };
  }
  fs.writeFileSync(CATALOG, `${JSON.stringify(next, null, 2)}\n`);
  return next;
}

function main() {
  const args = new Set(process.argv.slice(2));
  const scanned = scan();
  if (args.has('--json')) {
    console.log(JSON.stringify(scanned, null, 2));
    return 0;
  }
  const catalog = readCatalog();
  if (args.has('--write')) {
    const next = write(scanned, catalog);
    const d = compare(scanned, next);
    console.log(`env catalog written: ${Object.keys(next.variables).length} variables, ${d.undocumented.length} forwarded without description`);
    return 0;
  }
  const d = compare(scanned, catalog);
  const problems = [
    ...d.missing.map((n) => `not in catalog: ${n}`),
    ...d.stale.map((n) => `in catalog but unused: ${n}`),
    ...d.mismatched.map((n) => `services/forwarded/default out of date: ${n}`),
    ...d.undocumented.map((n) => `forwarded by compose but not described: ${n}`),
  ];
  if (problems.length) {
    console.error(`shared/envCatalog.json is out of date (${problems.length}). Run: node scripts/env-catalog.cjs --write, then describe new entries.`);
    for (const p of problems) console.error(`  - ${p}`);
    return 1;
  }
  console.log(`env catalog OK: ${Object.keys(scanned).length} variables`);
  return 0;
}

if (require.main === module) process.exitCode = main();

module.exports = { compare, guessCategory, parseCompose, parseReference, scan, SECRET_NAME };
