/**
 * FeatureAlignment → Finding adapter
 * Translates featureAlignmentScanner output into normalized Finding upsert data.
 * Key findings: orphan endpoints (backend with no frontend/docs) and undocumented endpoints.
 */

/**
 * @param {Object} scanResult — return value of featureAlignmentScanner.scanWorkspace()
 * @param {string} repo
 * @param {string} repoPath
 * @returns {Array<Object>}
 */
function adapt(scanResult, repo, repoPath) {
  const findings = [];

  // Orphan endpoints — backend routes with no frontend or docs coverage
  for (const ep of (scanResult.orphanEndpoints || [])) {
    const evidenceKey = `orphan_endpoint::${ep.method}::${ep.path}`;
    findings.push({
      repo,
      repoPath,
      scanner: 'feature-alignment',
      category: 'orphan_endpoint',
      severity: 'medium',
      confidence: ep.confidence || 0.7,
      title: `Orphan endpoint: ${ep.method} ${ep.path}`,
      description: `API endpoint exists in backend (${ep.sourceFile}) but has no frontend usage or documentation`,
      evidence: {
        method: ep.method,
        path: ep.path,
        sourceFile: ep.sourceFile,
        confidence: ep.confidence
      },
      suggestedAction: `Add frontend usage or documentation for ${ep.method} ${ep.path}, or remove if unused`,
      evidenceKey
    });
  }

  // Features that exist but are undocumented
  const undocumented = (scanResult.features || []).filter(f => f.status === 'undocumented');
  for (const feat of undocumented) {
    const evidenceKey = `undocumented_endpoint::${feat.key}`;
    const endpoints = feat.backend?.endpoints || [];
    findings.push({
      repo,
      repoPath,
      scanner: 'feature-alignment',
      category: 'undocumented_endpoint',
      severity: 'low',
      confidence: 0.75,
      title: `Undocumented feature: ${feat.key}`,
      description: `Feature "${feat.key}" has backend implementation (${endpoints.length} endpoint${endpoints.length !== 1 ? 's' : ''}) but no documentation`,
      evidence: {
        featureKey: feat.key,
        endpoints: endpoints.slice(0, 5),
        frontendFiles: feat.frontend?.files || []
      },
      suggestedAction: `Add documentation for feature "${feat.key}" to docs/api/reference.md`,
      evidenceKey
    });
  }

  // Summary-level finding if alignment is broadly poor
  const counts = scanResult.summary?.counts || {};
  const total = counts.features || 0;
  const orphans = counts.orphanEndpoints || 0;
  if (total > 0 && orphans / total > 0.3) {
    findings.push({
      repo,
      repoPath,
      scanner: 'feature-alignment',
      category: 'missing_docs',
      severity: 'medium',
      confidence: 0.85,
      title: `High orphan endpoint ratio: ${orphans}/${total} features undocumented`,
      description: `${Math.round((orphans / total) * 100)}% of features have orphan backend endpoints`,
      evidence: { orphans, total, ratio: orphans / total },
      suggestedAction: 'Run feature alignment scan and address undocumented endpoints systematically',
      evidenceKey: `high_orphan_ratio::${repo}`
    });
  }

  return findings;
}

module.exports = { adapt };
