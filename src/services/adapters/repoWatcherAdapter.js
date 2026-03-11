/**
 * RepoWatcher → Finding adapter
 * Translates repoWatcherService scan output into normalized Finding upsert data.
 */

const SEVERITY_MAP = { fail: 'high', warn: 'medium', info: 'info' };

const CATEGORY_MAP = {
  missing_test: 'missing_test',
  doc_duplication: 'doc_duplication',
  code_duplication: 'code_duplication',
  architecture_violation: 'architecture_violation',
  missing_docs: 'missing_docs',
  stale_docs: 'stale_docs',
  structural_drift: 'structural_drift',
  code_quality: 'code_quality'
};

/**
 * @param {Object} scanResult — return value of repoWatcherService.scan()
 * @param {string} repo — repo identifier ('agentx' | 'dataapi')
 * @param {string} repoPath
 * @returns {Array<Object>} array of finding upsert data objects
 */
function adapt(scanResult, repo, repoPath) {
  const findings = [];
  for (const f of (scanResult.findings || [])) {
    const category = CATEGORY_MAP[f.type] || 'unknown';
    const severity = SEVERITY_MAP[f.severity] || 'info';
    const evidenceKey = `${f.path || ''}::${f.type}`;

    findings.push({
      repo,
      repoPath,
      scanner: 'repo-watcher',
      category,
      severity,
      confidence: typeof f.confidence === 'number' ? f.confidence : 0.8,
      title: `[${f.type.replace(/_/g, ' ')}] ${(f.path || 'unknown').split('/').pop()}`,
      description: f.evidence || '',
      evidence: { path: f.path, raw: f.evidence, metadata: f.metadata || {} },
      suggestedAction: suggestAction(category, f),
      evidenceKey
    });
  }
  return findings;
}

function suggestAction(category, f) {
  switch (category) {
    case 'missing_test': return `Add unit tests for ${f.path}`;
    case 'code_duplication': return `Refactor duplicated logic in ${f.path}`;
    case 'architecture_violation': return `Review architecture boundary in ${f.path}`;
    case 'missing_docs': return `Add documentation for ${f.path}`;
    case 'stale_docs': return `Update or remove stale docs at ${f.path}`;
    case 'code_quality': return `Review code quality issues in ${f.path}`;
    default: return `Review ${f.path}`;
  }
}

module.exports = { adapt };
