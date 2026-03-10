/**
 * ValidationScanner → Finding adapter
 * Translates validationScanner output into normalized Finding upsert data.
 * Key findings: orphan services, unmounted routes, unused service functions.
 */

/**
 * @param {Object} scanResult — { serviceCoverage, modelCoverage, docCoverage, routeMounting }
 * @param {string} repo
 * @param {string} repoPath
 * @returns {Array<Object>}
 */
function adapt(scanResult, repo, repoPath) {
  const findings = [];

  const { serviceCoverage, routeMounting } = scanResult;

  // Orphan services (no consumers at all)
  const orphanServices = (serviceCoverage?.services || []).filter(s => s.classification === 'orphan');
  for (const svc of orphanServices) {
    const evidenceKey = `unused_service::${svc.file}`;
    findings.push({
      repo,
      repoPath,
      scanner: 'validation-scanner',
      category: 'unused_service',
      severity: 'medium',
      confidence: 0.85,
      title: `Orphan service: ${svc.file.split('/').pop()}`,
      description: `Service file "${svc.file}" has no consumers (routes or other services)`,
      evidence: {
        file: svc.file,
        exportedFunctions: svc.exportedFunctions || [],
        consumers: svc.consumers || []
      },
      suggestedAction: `Review "${svc.file}" — remove if unused or wire to a route`,
      evidenceKey
    });
  }

  // Partially-used services with many unused exports
  const partialServices = (serviceCoverage?.services || []).filter(
    s => s.classification === 'partially-used' && (s.unusedFunctions || []).length >= 3
  );
  for (const svc of partialServices) {
    const evidenceKey = `partial_service::${svc.file}`;
    findings.push({
      repo,
      repoPath,
      scanner: 'validation-scanner',
      category: 'unused_service',
      severity: 'low',
      confidence: 0.7,
      title: `Partially-used service: ${svc.file.split('/').pop()} (${svc.unusedFunctions.length} unused exports)`,
      description: `Service "${svc.file}" has ${svc.unusedFunctions.length} exported functions with no consumers: ${svc.unusedFunctions.slice(0, 4).join(', ')}${svc.unusedFunctions.length > 4 ? '...' : ''}`,
      evidence: {
        file: svc.file,
        unusedFunctions: svc.unusedFunctions,
        usedFunctions: svc.usedFunctions || []
      },
      suggestedAction: `Consider removing unused exports from "${svc.file}"`,
      evidenceKey
    });
  }

  // Unmounted route files
  const unmounted = (routeMounting?.unmounted || []).filter(r => !(routeMounting?.archived || []).includes(r.file));
  for (const route of unmounted) {
    const evidenceKey = `unmounted_route::${route.file}`;
    findings.push({
      repo,
      repoPath,
      scanner: 'validation-scanner',
      category: 'unmounted_route',
      severity: 'medium',
      confidence: 0.9,
      title: `Unmounted route file: ${route.file.split('/').pop()}`,
      description: `Route file "${route.file}" is not mounted in app.js`,
      evidence: { file: route.file },
      suggestedAction: `Mount "${route.file}" in src/app.js or archive it if deprecated`,
      evidenceKey
    });
  }

  return findings;
}

module.exports = { adapt };
