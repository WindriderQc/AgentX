/**
 * DocJanitor → Finding adapter
 * Translates docJanitorService scan output into normalized Finding upsert data.
 */

const SEVERITY_MAP = { fail: 'high', warn: 'medium', info: 'info' };

/**
 * @param {Object} scanResult — return value of docJanitorService.scan()
 * @param {string} repo
 * @param {string} repoPath
 * @returns {Array<Object>}
 */
function adapt(scanResult, repo, repoPath) {
  const findings = [];

  // Observations (structured problems detected)
  for (const obs of (scanResult.observations || [])) {
    const severity = SEVERITY_MAP[obs.severity] || 'medium';
    const category = mapObsCategory(obs.type);
    const evidenceKey = `${obs.type}::${JSON.stringify(obs.metadata || {}).substring(0, 80)}`;

    findings.push({
      repo,
      repoPath,
      scanner: 'doc-janitor',
      category,
      severity,
      confidence: 0.9,
      title: obs.message || obs.type,
      description: obs.message || '',
      evidence: { type: obs.type, metadata: obs.metadata || {} },
      suggestedAction: suggestAction(obs.type, obs),
      evidenceKey
    });
  }

  // UNKNOWN-classified files (docs with no known purpose)
  const unknownFiles = (scanResult.files || []).filter(f => f.category === 'UNKNOWN');
  if (unknownFiles.length > 0) {
    findings.push({
      repo,
      repoPath,
      scanner: 'doc-janitor',
      category: 'stale_docs',
      severity: 'low',
      confidence: 0.6,
      title: `${unknownFiles.length} unclassified doc files`,
      description: `Files not referenced in docs/INDEX.md and not recognized as permanent: ${unknownFiles.slice(0, 5).map(f => f.path).join(', ')}${unknownFiles.length > 5 ? ' ...' : ''}`,
      evidence: { count: unknownFiles.length, paths: unknownFiles.map(f => f.path) },
      suggestedAction: 'Add to docs/INDEX.md or remove if stale',
      evidenceKey: `unknown_files::count::${unknownFiles.length}`
    });
  }

  // Broken index links
  const summary = scanResult.summary || {};
  if (summary.brokenIndexLinks > 0) {
    findings.push({
      repo,
      repoPath,
      scanner: 'doc-janitor',
      category: 'broken_link',
      severity: 'medium',
      confidence: 1.0,
      title: `${summary.brokenIndexLinks} broken links in docs/INDEX.md`,
      description: 'docs/INDEX.md references files that do not exist',
      evidence: { count: summary.brokenIndexLinks },
      suggestedAction: 'Fix or remove broken links from docs/INDEX.md',
      evidenceKey: `broken_index_links::${summary.brokenIndexLinks}`
    });
  }

  return findings;
}

function mapObsCategory(type) {
  const map = {
    missing_docs_index: 'missing_docs',
    broken_index_links: 'broken_link',
    high_unknown_ratio: 'stale_docs',
    stale_content: 'stale_docs',
    duplicate_content: 'doc_duplication'
  };
  return map[type] || 'stale_docs';
}

function suggestAction(type, obs) {
  switch (type) {
    case 'missing_docs_index': return 'Create or update docs/INDEX.md';
    case 'broken_index_links': return 'Fix broken links in docs/INDEX.md';
    case 'high_unknown_ratio': return 'Classify doc files and add to INDEX.md';
    default: return obs.message || 'Review documentation';
  }
}

module.exports = { adapt };
