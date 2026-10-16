'use strict';
const { fail } = require('./pipelineManualReportClaim');
const { digest } = require('./pipelineReportAuthority');
const HASH = /^[a-f0-9]{64}$/;
function inventory(value, sourceCommit) {
  if (!value || value.sourceCommit !== sourceCommit || !Array.isArray(value.documents)
    || !value.documents.length || value.documents.length > 2000
    || new Set(value.documents.map(row => row?.path)).size !== value.documents.length
    || value.documents.some(row => !row || typeof row.path !== 'string' || row.path.length > 300
      || !/^[a-zA-Z0-9_.\/-]+\.md$/.test(row.path) || row.path.split('/').includes('..')
      || !HASH.test(row.sha256 || '')))
    throw fail('Freeze the exact Markdown inventory and source revision', 'REPORT_INVENTORY_INVALID', 400);
  const documents = value.documents.map(row => ({ path: row.path, sha256: row.sha256 })).sort((a, b) => a.path.localeCompare(b.path));
  return { sourceCommit, documents, sha256: digest({ sourceCommit, documents }) };
}
function coverage(value, snapshot) {
  if (value == null) return { inventorySha256: snapshot.sha256, documents: snapshot.documents.map(row => ({ ...row, state: 'pending', evidence: [] })) };
  if (Buffer.byteLength(JSON.stringify(value)) > 512 * 1024 || value.inventorySha256 !== snapshot.sha256 || !Array.isArray(value.documents)
    || value.documents.length !== snapshot.documents.length || new Set(value.documents.map(row => row?.path)).size !== value.documents.length)
    throw fail('Coverage must retain every frozen document exactly once', 'REPORT_COVERAGE_INVALID', 400);
  const docs = new Map(snapshot.documents.map(row => [row.path, row]));
  const documents = value.documents.map(row => {
    if (!row || !docs.has(row.path) || row.sha256 !== docs.get(row.path).sha256 || !['pending', 'reviewed', 'blocked', 'partial'].includes(row.state)
      || !Array.isArray(row.evidence) || row.evidence.length > 100 || (row.state === 'reviewed' && !row.evidence.length)
      || row.evidence.some(ref => !ref || typeof ref.path !== 'string' || ref.path.length > 300 || ref.path.split('/').includes('..')
        || !HASH.test(ref.sha256 || '') || !Number.isSafeInteger(ref.line) || ref.line < 1
        || typeof ref.check !== 'string' || !ref.check.trim() || ref.check.length > 1000))
      throw fail('Reviewed documents need concrete source references; unresolved scope stays visible', 'REPORT_COVERAGE_INVALID', 400);
    return { path: row.path, sha256: row.sha256, state: row.state,
      evidence: row.evidence.map(ref => ({ path: ref.path, sha256: ref.sha256, line: ref.line, check: ref.check })) };
  });
  return { inventorySha256: snapshot.sha256, documents,
    declaredComplete: documents.every(row => row.state === 'reviewed'), acceptance: 'independent_review_required' };
}
module.exports = { inventory, coverage };
