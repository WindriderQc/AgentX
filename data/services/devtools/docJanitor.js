/**
 * docJanitor.js — markdown documentation classifier (dev/governance tooling).
 *
 * NOTE: this operates on the MONOREPO's own markdown docs, not NAS data. It is
 * intentionally namespaced under the data service's `devtools/` directory to
 * keep it separate from the NAS data toolkits.
 *
 * Walks a repository's `.md` files, classifies each as PERMANENT / TRANSIENT /
 * UNKNOWN by deterministic rules (frontmatter, docs-map authority, canonical
 * names, permanent/transient dirs, filename keywords, ISO dates), validates
 * the canonical docs index, and emits findings.json + summary.md to an output
 * directory.
 *
 * The git `TODO/` tree is the retired task membrane — task truth moved to the
 * Mongo pipeline (`/api/pipeline/*`) in the 2026-06-26 cutover. Anything still
 * under `TODO/` is classified as historical/TRANSIENT; the old ROADMAP.md-driven
 * active-vs-completed logic has been removed.
 *
 * Ported from the ad-hoc classifier at /tmp/dj-classify.js (2026-04-23 first
 * run) per ADR 0002: deterministic capabilities live as service endpoints, not
 * roles.
 */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const CANONICAL_NAMES = new Set([
  'readme.md', 'contributing.md', 'changelog.md',
  'claude.md', 'agents.md', 'governance.md', 'workflow.md', 'api.md',
  'llm.md', 'llm_usage.md'
]);

const PERMANENT_DOC_DIRS = [
  'docs/architecture/', 'docs/operations/', 'docs/patterns/', 'docs/api/',
  'docs/guides/', 'docs/onboarding/', 'docs/user-manual/', 'docs/integrations/'
];

const TRANSIENT_DIRS = [
  'docs/reports/', 'docs/future/', 'docs/_archive/', 'docs/audits/'
];

const TRANSIENT_KEYWORDS = [
  'wip', 'draft', 'plan', 'notes', 'progress', 'meeting',
  'review', 'scratch', 'brainstorm', 'handoff', 'deliverable',
  'summary', 'complete', 'session', 'sprint-close', 'peer-review'
];

const DATE_RE = /\d{4}-\d{2}-\d{2}/;

// Directory names pruned from the walk (matches the old `find -not -path` set).
// Cross-platform JS walk — no dependency on a Unix `find` binary (works on the
// Windows dev host too). Returns repo-root-relative POSIX paths.
const PRUNED_DIRS = new Set([
  'node_modules', '.git', 'logs', 'coverage', 'dist', 'build',
  'test-results', '.worktrees', '.claude'
]);

function listMdFiles(repoRoot) {
  // The documentation policy defines repository-wide review scope as tracked
  // files. Ignored scratch/runtime residue must not inflate the corpus or its
  // UNKNOWN bucket. Keep the filesystem walker as a fallback for non-Git
  // fixture directories and exported source trees.
  try {
    const tracked = execFileSync(
      'git',
      ['-C', repoRoot, 'ls-files', '-z', '--', '*.md', '*.MD'],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }
    );
    return tracked
      .split('\0')
      .filter(Boolean)
      .map(rel => rel.replace(/\\/g, '/'));
  } catch {
    // Fall through to the dependency-free walker below.
  }

  const found = [];
  function walk(dir) {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
    catch { return; }
    for (const ent of entries) {
      if (ent.isSymbolicLink()) continue;
      if (ent.isDirectory()) {
        if (PRUNED_DIRS.has(ent.name)) continue;
        walk(path.join(dir, ent.name));
      } else if (ent.isFile() && ent.name.toLowerCase().endsWith('.md')) {
        const rel = path.relative(repoRoot, path.join(dir, ent.name));
        found.push(rel.split(path.sep).join('/'));
      }
    }
  }
  walk(repoRoot);
  return found;
}

function basename(p) { return path.basename(p).toLowerCase(); }

function isTransientByName(p) {
  const b = basename(p);
  if (DATE_RE.test(b)) return true;
  return TRANSIENT_KEYWORDS.some(k => b.includes(k));
}

function normalizeRepoPath(value) {
  return value.replace(/^\.\//, '').replace(/\\/g, '/');
}

function unquote(value) {
  const trimmed = value.trim();
  if ((trimmed.startsWith('"') && trimmed.endsWith('"'))
      || (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function parseFrontmatter(text) {
  const lines = text.split(/\r?\n/);
  if (lines[0]?.trim() !== '---') return null;

  const end = lines.slice(1).findIndex(line => line.trim() === '---');
  if (end < 0) return null;

  const metadata = {};
  for (const line of lines.slice(1, end + 1)) {
    const match = line.match(/^([A-Za-z0-9_-]+):\s*(.*?)\s*$/);
    if (!match || !match[2]) continue;
    metadata[match[1]] = unquote(match[2]);
  }
  return metadata;
}

function readDocsMap(repoRoot) {
  const result = {
    path: null,
    canonical: new Set(),
    verification: new Set(),
    supporting: new Set(),
    historical: new Set()
  };
  const docsMapPath = path.join(repoRoot, 'config', 'docs-map.yml');
  if (!fs.existsSync(docsMapPath)) return result;

  result.path = 'config/docs-map.yml';
  const lines = fs.readFileSync(docsMapPath, 'utf8').split(/\r?\n/);
  let section = null;

  const add = (kind, raw) => {
    const value = unquote(raw);
    if (!value.startsWith('./') || !value.toLowerCase().endsWith('.md')) return;
    const normalized = normalizeRepoPath(value);
    if (kind === 'canonical') result.canonical.add(normalized);
    if (kind === 'verify_against') result.verification.add(normalized);
    if (kind === 'supporting') result.supporting.add(normalized);
    if (kind === 'historical_allowed') result.historical.add(normalized);
  };

  for (const line of lines) {
    const field = line.match(/^\s{4}(canonical|verify_against|supporting|historical_allowed):\s*(.*?)\s*$/);
    if (field) {
      section = field[1];
      if (field[2] && field[2] !== '[]') add(section, field[2]);
      continue;
    }

    const item = line.match(/^\s{6}-\s+(.*?)\s*$/);
    if (item && section) {
      add(section, item[1]);
      continue;
    }

    if (line.trim() && !/^\s{6}/.test(line)) section = null;
  }

  return result;
}

function readLifecycleInventory(repoRoot) {
  const result = { path: null, artifacts: new Map() };
  const inventoryPath = path.join(
    repoRoot,
    'docs',
    'progress',
    'documentation-migration',
    'inventory.yml'
  );
  if (!fs.existsSync(inventoryPath)) return result;

  result.path = 'docs/progress/documentation-migration/inventory.yml';
  const lines = fs.readFileSync(inventoryPath, 'utf8').split(/\r?\n/);
  let current = null;

  const save = () => {
    if (!current?.path || !current.class) return;
    result.artifacts.set(normalizeRepoPath(current.path), current);
  };

  for (const line of lines) {
    const artifact = line.match(/^  - path:\s*(.*?)\s*$/);
    if (artifact) {
      save();
      current = { path: unquote(artifact[1]) };
      continue;
    }
    if (!current) continue;

    const field = line.match(/^    (class|authority|classification_reason|migration_state):\s*(.*?)\s*$/);
    if (field) current[field[1]] = unquote(field[2]);
  }
  save();
  return result;
}

function inspectDocsIndex(repoRoot) {
  const indexPath = path.join(repoRoot, 'docs', 'INDEX.md');
  if (!fs.existsSync(indexPath)) {
    return { exists: false, path: null, links: [], referenced: new Set(), broken: [] };
  }

  const text = fs.readFileSync(indexPath, 'utf8');
  const links = [];
  const referenced = new Set();
  const broken = [];
  const markdownLink = /!?\[[^\]]*\]\(([^)]+)\)/g;
  let match;

  while ((match = markdownLink.exec(text)) !== null) {
    let target = match[1].trim();
    if (target.startsWith('<') && target.endsWith('>')) target = target.slice(1, -1);
    target = target.split(/\s+["']/)[0];
    if (/^(https?:\/\/|mailto:|#)/i.test(target)) continue;
    target = target.split('#', 1)[0];
    if (!target) continue;

    try { target = decodeURIComponent(target); } catch { /* keep literal target */ }
    const resolved = path.resolve(path.dirname(indexPath), target);
    const rel = normalizeRepoPath(path.relative(repoRoot, resolved));
    links.push(rel);

    if (fs.existsSync(resolved)) {
      if (fs.statSync(resolved).isFile()) referenced.add(rel);
    } else {
      broken.push({ target, resolved_path: rel });
    }
  }

  return { exists: true, path: 'docs/INDEX.md', links, referenced, broken };
}

function classify(p, { frontmatter = null, docsMap = null, inventoryEntry = null } = {}) {
  const rel = p.replace(/\\/g, '/');
  const b = basename(rel);

  const docType = frontmatter?.doc_type?.toLowerCase();
  const status = frontmatter?.status?.toLowerCase();
  if (['historical', 'generated', 'progression'].includes(docType)
      || ['closed', 'superseded', 'frozen'].includes(status)) {
    return { category: 'TRANSIENT', reason: `Lifecycle metadata (${docType || status})` };
  }
  if (docType === 'permanent') {
    return { category: 'PERMANENT', reason: 'Lifecycle metadata (permanent)' };
  }

  if (rel.startsWith('roles/')) {
    return { category: 'PERMANENT', reason: 'Active role playbook' };
  }

  // Retired git TODO/ membrane — task truth moved to the Mongo pipeline
  // (2026-06-26 cutover). Everything still under TODO/ is historical.
  if (rel.startsWith('TODO/')) {
    return { category: 'TRANSIENT', reason: 'Retired git TODO/ membrane (historical; task truth is the Mongo pipeline)' };
  }

  if (CANONICAL_NAMES.has(b)) {
    if (!rel.startsWith('docs/audits/')) {
      return { category: 'PERMANENT', reason: 'Canonical repo/service doc' };
    }
  }

  for (const d of TRANSIENT_DIRS) {
    if (rel.startsWith(d)) return { category: 'TRANSIENT', reason: `Under ${d}` };
  }

  if (docsMap?.historical.has(rel)) {
    return { category: 'TRANSIENT', reason: 'Mapped as historical in config/docs-map.yml' };
  }
  if (docsMap?.canonical.has(rel)) {
    return { category: 'PERMANENT', reason: 'Canonical in config/docs-map.yml' };
  }
  if (docsMap?.verification.has(rel)) {
    return { category: 'PERMANENT', reason: 'Verification authority in config/docs-map.yml' };
  }
  if (docsMap?.supporting.has(rel)) {
    return { category: 'PERMANENT', reason: 'Supporting authority in config/docs-map.yml' };
  }

  const inventoryClass = inventoryEntry?.class?.toLowerCase();
  if (['historical', 'generated', 'progression'].includes(inventoryClass)) {
    return {
      category: 'TRANSIENT',
      reason: `Lifecycle inventory (${inventoryClass}; ${inventoryEntry.migration_state || 'state unspecified'})`
    };
  }
  if (inventoryClass === 'permanent') {
    return { category: 'PERMANENT', reason: 'Lifecycle inventory (permanent)' };
  }

  if (rel === 'TODO_TASK_TEMPLATE.md') {
    return { category: 'PERMANENT', reason: 'TODO template, referenced by WORKFLOW' };
  }

  if (!rel.includes('/') && /^todo[-_]/i.test(b)) {
    return { category: 'TRANSIENT', reason: 'Root-level TODO-prefixed doc (should live under TODO/ or be archived)' };
  }

  for (const d of PERMANENT_DOC_DIRS) {
    if (rel.startsWith(d)) {
      if (isTransientByName(rel)) {
        return { category: 'TRANSIENT', reason: `Under ${d} but filename suggests transient/WIP` };
      }
      return { category: 'PERMANENT', reason: `Core docs area (${d})` };
    }
  }

  if (rel.startsWith('docs/decisions/') || rel.startsWith('docs/benchmark/') || rel.startsWith('docs/superpowers/')) {
    if (isTransientByName(rel)) {
      return { category: 'TRANSIENT', reason: `Under ${rel.split('/').slice(0, 2).join('/')}/ but filename transient` };
    }
    return { category: 'PERMANENT', reason: `Scoped docs area (${rel.split('/').slice(0, 2).join('/')}/)` };
  }

  if (rel.startsWith('docs/') && rel.split('/').length === 2) {
    if (isTransientByName(rel)) {
      return { category: 'TRANSIENT', reason: 'docs/ root file with transient filename' };
    }
    return { category: 'PERMANENT', reason: 'docs/ root canonical reference' };
  }

  if (!rel.includes('/') && isTransientByName(rel)) {
    return { category: 'TRANSIENT', reason: 'Root-level status/summary document' };
  }

  if (/(^|\/)(tests|scripts|gift)\//.test(rel) || /(^|\/)public\//.test(rel)) {
    if (isTransientByName(rel)) {
      return { category: 'TRANSIENT', reason: 'Under tests/scripts/public/ with transient name' };
    }
    return { category: 'PERMANENT', reason: 'Test/script/public companion doc' };
  }

  if (rel.startsWith('docs/')) {
    return { category: 'UNKNOWN', reason: 'Under docs/ but not clearly mapped' };
  }

  if (isTransientByName(rel)) {
    return { category: 'TRANSIENT', reason: 'Filename suggests transient/WIP' };
  }

  return { category: 'UNKNOWN', reason: 'Outside docs/ and not canonical' };
}

function buildObservations(files, summary, indexInfo) {
  const observations = [];

  if (!indexInfo.exists) {
    observations.push({
      severity: 'warn',
      type: 'missing_docs_index',
      message: 'No docs/INDEX.md present. Authority derived from root canonical files only.'
    });
  }

  if (indexInfo.broken.length > 0) {
    observations.push({
      severity: 'fail',
      type: 'broken_docs_index_links',
      message: `${indexInfo.broken.length} broken relative link(s) in docs/INDEX.md.`,
      metadata: { links: indexInfo.broken }
    });
  }

  if (summary.unknown > 0) {
    observations.push({
      severity: 'fail',
      type: 'unclassified_docs',
      message: `${summary.unknown} tracked Markdown file(s) have no authoritative lifecycle classification.`,
      metadata: { paths: files.filter(f => f.category === 'UNKNOWN').map(f => f.path) }
    });
  }

  // The whole git TODO/ tree is retired (task truth is the Mongo pipeline), so
  // any files still under it are historical and can be archived wholesale.
  const todoCount = files.filter(f => f.path.startsWith('TODO/')).length;
  if (todoCount > 0) {
    observations.push({
      severity: 'info',
      type: 'retired_todo_tree_present',
      message: `${todoCount} file(s) remain under the retired git TODO/ tree. Task truth moved to the Mongo pipeline; these are historical and can be archived.`,
      metadata: { count: todoCount }
    });
  }

  const unknownRatio = summary.total_md_files > 0 ? summary.unknown / summary.total_md_files : 0;
  if (unknownRatio > 0.2) {
    observations.push({
      severity: 'warn',
      type: 'high_unknown_ratio',
      message: `UNKNOWN rate ${Math.round(unknownRatio * 100)}% exceeds 20% threshold`,
      metadata: { unknown: summary.unknown, total: summary.total_md_files }
    });
  }

  const rootTransient = files.filter(f => !f.path.includes('/') && f.category === 'TRANSIENT');
  if (rootTransient.length > 0) {
    observations.push({
      severity: 'info',
      type: 'root_transient',
      message: `${rootTransient.length} root-level transient file(s) — consider relocating or archiving.`,
      metadata: { paths: rootTransient.map(f => f.path) }
    });
  }

  return observations;
}

function buildRecommendations(files, indexInfo) {
  const recs = [];

  const todoCount = files.filter(f => f.path.startsWith('TODO/')).length;
  if (todoCount > 0) {
    recs.push({
      severity: 'info',
      title: 'Archive the retired git TODO/ tree',
      message: `${todoCount} file(s) remain under TODO/. The git task membrane is retired — task truth is the Mongo pipeline (/api/pipeline/*) — so the whole tree is historical.`,
      related_paths: ['TODO/'],
      actions: [
        'Move TODO/** to an archive location (e.g. docs/_archive/TODO-<YYYY-MM>/) or drop it from git',
        'Confirm no code or docs still read TODO/ before removing (grep "TODO/")'
      ]
    });
  }

  const rootTransient = files.filter(f => !f.path.includes('/') && f.category === 'TRANSIENT');
  if (rootTransient.length > 0) {
    recs.push({
      severity: 'info',
      title: 'Relocate root-level transient docs',
      message: 'Root-level files with transient names clutter the ecosystem root. Move them under docs/_archive/ or dedicated scoped areas.',
      related_paths: rootTransient.map(f => f.path),
      actions: rootTransient.map(f => `Move ${f.path} → docs/_archive/2026-04/${path.basename(f.path)}`)
    });
  }

  if (!indexInfo.exists) {
    recs.push({
      severity: 'info',
      title: 'Create docs/INDEX.md as canonical authority',
      message: 'No index currently exists. A docs/INDEX.md linking PERMANENT docs would let future DocJanitor runs use index-authority (higher confidence) instead of path heuristics.',
      related_paths: ['docs/'],
      actions: [
        'Draft docs/INDEX.md linking every PERMANENT doc surfaced by this scan',
        'Add PR review rule: new docs must be linked from INDEX.md or land under docs/_archive/'
      ]
    });
  }

  if (indexInfo.broken.length > 0) {
    recs.push({
      severity: 'fail',
      title: 'Repair broken docs index links',
      message: `${indexInfo.broken.length} relative link(s) in docs/INDEX.md do not resolve.`,
      related_paths: ['docs/INDEX.md'],
      actions: indexInfo.broken.map(link => `Repair or remove ${link.target}`)
    });
  }

  const unknowns = files.filter(f => f.category === 'UNKNOWN');
  if (unknowns.length > 0) {
    recs.push({
      severity: 'warn',
      title: `Triage ${unknowns.length} UNKNOWN doc(s)`,
      message: 'These files could not be classified confidently; a human should mark each as keep, archive, or delete.',
      related_paths: unknowns.map(f => f.path),
      actions: ['Review each path', 'Move to appropriate docs/ or TODO/ subtree, or archive']
    });
  }

  return recs;
}

function buildSummaryMarkdown(findings) {
  const { summary, observations, recommendations, files, scanned_at, status, target_repo, index_path } = findings;
  const topRecs = recommendations.slice(0, 5).map((r, i) => `${i + 1}. **${r.title}** — ${r.message}`).join('\n');
  const obs = observations.map(o => `- [${o.severity}] **${o.type}**: ${o.message}`).join('\n');
  const unknowns = files.filter(f => f.category === 'UNKNOWN');
  const unknownList = unknowns.length === 0
    ? '_(none)_'
    : unknowns.map(f => `- \`${f.path}\` — ${f.reason}`).join('\n');

  return `# DocJanitor Scan — ${path.basename(target_repo)}

**Scanned:** ${scanned_at}
**Status:** ${status}
**Target:** ${target_repo}
**Index:** ${index_path || 'none (authority from lifecycle metadata, docs-map, and path rules)'}

## Summary
- Total .md files: **${summary.total_md_files}**
- PERMANENT: ${summary.permanent}
- TRANSIENT: ${summary.transient}
- UNVERIFIED: ${summary.unverified}
- UNKNOWN: ${summary.unknown}

## Observations
${obs}

## Top recommendations
${topRecs}

## UNKNOWN files
${unknownList}

## Next steps
- Human reviews findings.json
- Decide per recommendation: approve / defer / reject
- Execute approved moves (DocJanitor does not execute)
- Optionally create docs/INDEX.md so the next run uses index-authority
`;
}

/**
 * Run the scan against `targetRepo`. Returns the findings object. If
 * `outputDir` is provided and writable, also writes findings.json + summary.md
 * there.
 */
function scan({ targetRepo, outputDir = null }) {
  if (!targetRepo) throw new Error('targetRepo required');
  const resolved = path.resolve(targetRepo);
  if (!fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) {
    throw new Error(`targetRepo not found or not a directory: ${resolved}`);
  }

  const paths = listMdFiles(resolved);
  const docsMap = readDocsMap(resolved);
  const lifecycleInventory = readLifecycleInventory(resolved);
  const indexInfo = inspectDocsIndex(resolved);

  const files = paths.map(p => {
    const full = path.join(resolved, p);
    let stat = null;
    try { stat = fs.statSync(full); } catch { /* ignore */ }
    let text = '';
    try { text = fs.readFileSync(full, 'utf8'); } catch { /* ignore */ }
    const cls = classify(p, {
      frontmatter: parseFrontmatter(text),
      docsMap,
      inventoryEntry: lifecycleInventory.artifacts.get(p)
    });
    return {
      path: p,
      category: cls.category,
      reason: cls.reason,
      referenced_by_index: indexInfo.referenced.has(p),
      size_bytes: stat ? stat.size : 0,
      mtime: stat ? stat.mtime.toISOString() : null,
      mismatches: []
    };
  }).sort((a, b) => a.path.localeCompare(b.path));

  const summary = {
    total_md_files: files.length,
    permanent: files.filter(f => f.category === 'PERMANENT').length,
    transient: files.filter(f => f.category === 'TRANSIENT').length,
    unverified: files.filter(f => f.category === 'UNVERIFIED').length,
    unknown: files.filter(f => f.category === 'UNKNOWN').length,
    index_links: indexInfo.links.length,
    broken_index_links: indexInfo.broken.length
  };

  const observations = buildObservations(files, summary, indexInfo);
  const recommendations = buildRecommendations(files, indexInfo);
  const status = observations.some(o => o.severity === 'fail') ? 'fail'
    : observations.some(o => o.severity === 'warn') ? 'warn'
      : 'ok';

  const findings = {
    target_repo: resolved,
    index_path: indexInfo.path,
    docs_map_path: docsMap.path,
    lifecycle_inventory_path: lifecycleInventory.path,
    scanned_at: new Date().toISOString(),
    status,
    summary,
    files,
    broken_index_links: indexInfo.broken,
    observations,
    recommendations
  };

  if (outputDir) {
    fs.mkdirSync(outputDir, { recursive: true });
    fs.writeFileSync(path.join(outputDir, 'findings.json'), JSON.stringify(findings, null, 2));
    fs.writeFileSync(path.join(outputDir, 'summary.md'), buildSummaryMarkdown(findings));
    findings.output_dir = outputDir;
  }

  return findings;
}

/**
 * Locate the most recent docjanitor audit dir under `<targetRepo>/docs/audits/`.
 * Returns null if none exist.
 */
function findLatestAudit(targetRepo) {
  const auditsRoot = path.join(targetRepo, 'docs/audits');
  if (!fs.existsSync(auditsRoot)) return null;
  const dirs = fs.readdirSync(auditsRoot, { withFileTypes: true })
    .filter(d => d.isDirectory() && d.name.startsWith('docjanitor-'))
    .map(d => d.name)
    .sort();
  if (dirs.length === 0) return null;
  const latest = dirs[dirs.length - 1];
  const dir = path.join(auditsRoot, latest);
  const findingsPath = path.join(dir, 'findings.json');
  if (!fs.existsSync(findingsPath)) return null;
  const findings = JSON.parse(fs.readFileSync(findingsPath, 'utf8'));
  return { dir, name: latest, findings };
}

/**
 * List all docjanitor audit runs (newest first) under the given repo.
 * Lightweight — reads only the summary fields, not the full files list.
 */
function listAudits(targetRepo, limit = 20) {
  const auditsRoot = path.join(targetRepo, 'docs/audits');
  if (!fs.existsSync(auditsRoot)) return [];
  const dirs = fs.readdirSync(auditsRoot, { withFileTypes: true })
    .filter(d => d.isDirectory() && d.name.startsWith('docjanitor-'))
    .map(d => d.name)
    .sort()
    .reverse()
    .slice(0, limit);

  return dirs.map(name => {
    const dir = path.join(auditsRoot, name);
    const findingsPath = path.join(dir, 'findings.json');
    if (!fs.existsSync(findingsPath)) return { name, dir, error: 'findings.json missing' };
    try {
      const f = JSON.parse(fs.readFileSync(findingsPath, 'utf8'));
      return {
        name,
        dir,
        scanned_at: f.scanned_at,
        status: f.status,
        summary: f.summary,
        observation_count: f.observations ? f.observations.length : 0,
        recommendation_count: f.recommendations ? f.recommendations.length : 0
      };
    } catch (e) {
      return { name, dir, error: e.message };
    }
  });
}

module.exports = { scan, findLatestAudit, listAudits };
