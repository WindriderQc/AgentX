const fs = require('fs').promises;
const path = require('path');
const DocJanitorScan = require('../../models/DocJanitorScan');
const logger = require('../../config/logger');
const { getRepoWatcherService } = require('./repoWatcherService');

function isLikelyTransientByName(filePath) {
  const base = path.basename(filePath).toLowerCase();
  const contains = (s) => base.includes(s);

  // Dated filenames (YYYY-MM-DD) are usually transient
  if (/\d{4}-\d{2}-\d{2}/.test(base)) return true;

  return [
    'wip', 'draft', 'plan', 'notes', 'todo', 'progress', 'meeting',
    'review', 'scratch', 'brainstorm', 'handoff', 'deliverable',
    'summary', 'complete', 'fix', 'report'
  ].some(contains);
}

function normalizeRepoRelativePath(p) {
  return p.replace(/\\/g, '/').replace(/^\.\/+/, '');
}

function extractMarkdownLinks(markdown) {
  // Capture (target) in [text](target), ignoring images ![...](...)
  const links = [];
  const re = /(^|[^!])\[[^\]]*]\(([^)]+)\)/g;
  let m;
  while ((m = re.exec(markdown)) !== null) {
    const target = (m[2] || '').trim();
    if (!target) continue;
    links.push(target);
  }
  return links;
}

function resolveDocIndexLink(repoPath, indexPath, linkTarget) {
  // Drop anchors
  const noAnchor = linkTarget.split('#')[0].trim();
  if (!noAnchor) return null;
  if (/^(https?:)?\/\//i.test(noAnchor)) return null;
  if (noAnchor.startsWith('mailto:')) return null;

  // Some links are root-relative like /docs/api/...
  if (noAnchor.startsWith('/')) {
    return normalizeRepoRelativePath(noAnchor.replace(/^\//, ''));
  }

  const indexDir = path.dirname(indexPath);
  const resolved = path.resolve(repoPath, indexDir, noAnchor);
  return normalizeRepoRelativePath(path.relative(repoPath, resolved));
}

function classifyFile({ filePath, referencedByIndex }) {
  const p = normalizeRepoRelativePath(filePath);
  const base = path.basename(p).toLowerCase();

  if (referencedByIndex) {
    return { category: 'PERMANENT', reason: 'Linked from docs/INDEX.md' };
  }

  if (base === 'readme.md' || base === 'contributing.md' || base === 'changelog.md' || base === 'claude.md') {
    return { category: 'PERMANENT', reason: 'Repository-level canonical documentation' };
  }

  if (p.startsWith('docs/reports/') || p.startsWith('docs/future/')) {
    return { category: 'TRANSIENT', reason: 'Reports/future planning area (likely historical or WIP)' };
  }

  if (p.startsWith('docs/_archive/')) {
    return { category: 'TRANSIENT', reason: 'Already archived' };
  }

  if (p.startsWith('docs/architecture/') || p.startsWith('docs/operations/') || p.startsWith('docs/patterns/') ||
      p.startsWith('docs/api/') || p.startsWith('docs/guides/') || p.startsWith('docs/onboarding/') ||
      p.startsWith('docs/user-manual/') || p.startsWith('docs/integrations/')) {
    if (isLikelyTransientByName(p)) {
      return { category: 'TRANSIENT', reason: 'Located under docs but filename suggests transient/WIP' };
    }
    return { category: 'PERMANENT', reason: 'Located in core docs area' };
  }

  // Root-level "status" docs tend to be transient in this repo
  if (!p.includes('/') && isLikelyTransientByName(p)) {
    return { category: 'TRANSIENT', reason: 'Root-level status/summary document' };
  }

  if (isLikelyTransientByName(p)) {
    return { category: 'TRANSIENT', reason: 'Filename suggests transient/WIP' };
  }

  if (p.startsWith('docs/')) {
    return { category: 'UNKNOWN', reason: 'Under docs/ but not clearly mapped or referenced' };
  }

  return { category: 'UNKNOWN', reason: 'Outside docs/ and not clearly canonical' };
}

class DocJanitorService {
  async scan(repoPath, workspaceId = null) {
    const start = Date.now();
    const repoWatcher = getRepoWatcherService();

    const snapshot = await repoWatcher.buildSnapshot(repoPath);
    const mdFiles = snapshot.files.filter(f => (f.path || '').toLowerCase().endsWith('.md'));

    const indexRel = 'docs/INDEX.md';
    const indexFile = snapshot.files.find(f => normalizeRepoRelativePath(f.path) === indexRel);

    const referenced = new Set();
    const brokenIndexLinks = [];
    let indexLinksCount = 0;

    if (indexFile) {
      try {
        const indexContent = await fs.readFile(indexFile.fullPath, 'utf-8');
        const links = extractMarkdownLinks(indexContent);
        indexLinksCount = links.length;

        for (const linkTarget of links) {
          const resolvedRel = resolveDocIndexLink(repoPath, indexRel, linkTarget);
          if (!resolvedRel) continue;
          if (!resolvedRel.toLowerCase().endsWith('.md')) continue;
          referenced.add(resolvedRel);

          const exists = snapshot.files.some(f => normalizeRepoRelativePath(f.path) === resolvedRel);
          if (!exists) {
            brokenIndexLinks.push({ linkTarget, resolvedRel });
          }
        }
      } catch (err) {
        logger.warn('Failed to read docs/INDEX.md for DocJanitor scan', { error: err.message });
      }
    }

    const files = mdFiles
      .map(f => {
        const rel = normalizeRepoRelativePath(f.path);
        const referencedByIndex = referenced.has(rel);
        const classified = classifyFile({ filePath: rel, referencedByIndex });
        return {
          path: rel,
          category: classified.category,
          reason: classified.reason,
          referencedByIndex,
          size: f.size || 0,
          mtime: f.mtime || null
        };
      })
      .sort((a, b) => a.path.localeCompare(b.path));

    const summary = {
      totalMdFiles: files.length,
      permanent: files.filter(x => x.category === 'PERMANENT').length,
      transient: files.filter(x => x.category === 'TRANSIENT').length,
      unknown: files.filter(x => x.category === 'UNKNOWN').length,
      indexLinks: indexLinksCount,
      brokenIndexLinks: brokenIndexLinks.length
    };

    const observations = [];
    if (!indexFile) {
      observations.push({
        severity: 'warn',
        type: 'missing_docs_index',
        message: 'docs/INDEX.md not found; permanent docs map cannot be derived from the index.'
      });
    }
    if (brokenIndexLinks.length > 0) {
      observations.push({
        severity: 'warn',
        type: 'broken_index_links',
        message: `docs/INDEX.md contains ${brokenIndexLinks.length} broken .md link(s).`,
        metadata: { brokenIndexLinks: brokenIndexLinks.slice(0, 50) }
      });
    }

    const unknownRatio = summary.totalMdFiles > 0 ? (summary.unknown / summary.totalMdFiles) : 0;
    if (unknownRatio > 0.2) {
      observations.push({
        severity: 'warn',
        type: 'high_unknown_ratio',
        message: `High UNKNOWN rate: ${Math.round(unknownRatio * 100)}% of .md files need classification.`,
        metadata: { unknown: summary.unknown, totalMdFiles: summary.totalMdFiles }
      });
    }

    // Recommendations (actionable, but DocJanitor v1 is non-destructive)
    const recommendations = [];
    if (brokenIndexLinks.length > 0) {
      recommendations.push({
        severity: 'warn',
        title: 'Fix broken links in docs/INDEX.md',
        message: 'The docs index should be the canonical map; broken links undermine navigation and RAG ingestion quality.',
        actions: [
          'Open docs/INDEX.md and update paths for missing/moved docs',
          'If a doc was archived, replace the link with the new location or remove it'
        ],
        relatedPaths: ['docs/INDEX.md']
      });
    }

    const rootTransient = files.filter(f => !f.path.includes('/') && f.category === 'TRANSIENT');
    if (rootTransient.length >= 10) {
      recommendations.push({
        severity: 'info',
        title: 'Consolidate root-level transient docs',
        message: `Found ${rootTransient.length} root-level status/summary markdown files. Consider consolidating and archiving to reduce clutter.`,
        actions: [
          'Create a single docs/reports/STATUS.md (or update ROADMAP.md) and link it from docs/INDEX.md',
          'Move older status docs under docs/reports/ or docs/_archive/'
        ],
        relatedPaths: rootTransient.slice(0, 25).map(f => f.path)
      });
    }

    const status = observations.some(o => o.severity === 'fail')
      ? 'fail'
      : observations.some(o => o.severity === 'warn')
        ? 'warn'
        : 'ok';

    const scan = new DocJanitorScan({
      workspaceId,
      repoPath,
      status,
      scanDuration: Date.now() - start,
      summary,
      files,
      observations,
      recommendations,
      scannedAt: new Date()
    });

    await scan.save();

    logger.info('DocJanitor scan completed', {
      repoPath,
      status,
      totalMdFiles: summary.totalMdFiles,
      scanDuration: scan.scanDuration
    });

    return {
      status: scan.status,
      summary: scan.summary,
      files: scan.files,
      observations: scan.observations,
      recommendations: scan.recommendations,
      lastScan: scan.scannedAt,
      scanDuration: scan.scanDuration
    };
  }

  async getStatus(repoPath, workspaceId = null) {
    const scan = await DocJanitorScan.getLatest(repoPath, workspaceId);
    if (!scan) {
      return {
        status: 'ok',
        summary: {
          totalMdFiles: 0,
          permanent: 0,
          transient: 0,
          unknown: 0,
          indexLinks: 0,
          brokenIndexLinks: 0
        },
        files: [],
        observations: [],
        recommendations: [],
        lastScan: null,
        nextScan: null
      };
    }

    return {
      status: scan.status,
      summary: scan.summary,
      files: scan.files,
      observations: scan.observations,
      recommendations: scan.recommendations,
      lastScan: scan.scannedAt,
      nextScan: null
    };
  }

  async getHistory(repoPath, workspaceId = null, limit = 20, skip = 0) {
    const query = { repoPath };
    if (workspaceId) query.workspaceId = workspaceId;

    const scans = await DocJanitorScan.find(query)
      .sort({ scannedAt: -1 })
      .skip(skip)
      .limit(limit)
      .select('status summary scannedAt scanDuration')
      .lean();

    const total = await DocJanitorScan.countDocuments(query);

    return {
      scans,
      total,
      page: Math.floor(skip / limit) + 1,
      pages: Math.ceil(total / limit)
    };
  }

  async getScanById(scanId, workspaceId = null) {
    const query = { _id: scanId };
    if (workspaceId) query.workspaceId = workspaceId;
    return DocJanitorScan.findOne(query).lean();
  }
}

let instance = null;
function getDocJanitorService() {
  if (!instance) instance = new DocJanitorService();
  return instance;
}

module.exports = { getDocJanitorService };

