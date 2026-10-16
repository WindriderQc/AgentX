(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.PipelineReportSelection = api;
})(typeof window === 'undefined' ? globalThis : window, function () {
  'use strict';
  const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
  const HASH = /^[a-f0-9]{64}$/;
  const filename = value => typeof value === 'string' && value.length <= 120 && /^[A-Za-z0-9][A-Za-z0-9._-]*\.md$/.test(value);
  function fail(message) { return Object.assign(new Error(message), { status: 400, statusCode: 400, code: 'REPORT_PROFILE_INVALID' }); }
  function parent(body) {
    const parentRequestId = body.parentRequestId ?? null, parentSha256 = body.parentSha256 ?? null;
    if (parentRequestId === null && parentSha256 === null) return {};
    if (typeof parentRequestId !== 'string' || !UUID.test(parentRequestId) || (parentSha256 !== null && (typeof parentSha256 !== 'string' || !HASH.test(parentSha256)))
      || parentRequestId === body.requestId) throw fail('A continuation needs the exact prior report request and file digest.');
    return { parentRequestId, parentSha256 };
  }
  function normalize(body = {}) {
    if (body.reportName == null || body.reportName === '') {
      if (body.modelCallLimit != null || body.parentRequestId != null || body.parentSha256 != null)
        throw fail('A report budget and checkpoint require private report mode.');
      return {};
    }
    if (!filename(body.reportName) || body.autonomous === true) throw fail('Choose a plain Markdown filename for a manual report.');
    if (body.documentPaths != null && (!Array.isArray(body.documentPaths) || !body.documentPaths.length || body.documentPaths.length > 2000
      || new Set(body.documentPaths).size !== body.documentPaths.length || body.documentPaths.some(path => typeof path !== 'string'
        || path.length > 300 || !/^[A-Za-z0-9_.\/-]+\.md$/.test(path) || path.split('/').includes('..'))))
      throw fail('Select exact tracked Markdown paths for the review inventory.');
    const modelCallLimit = body.modelCallLimit ?? 128;
    if (!Number.isSafeInteger(modelCallLimit) || modelCallLimit < 128 || modelCallLimit > 256)
      throw fail('Report model call limit must be an integer from 128 to 256.');
    return { reportName: body.reportName, modelCallLimit, ...(body.documentPaths ? { documentPaths: [...body.documentPaths].sort() } : {}), ...parent(body) };
  }
  function currentReport(task) {
    const latest = (task?.transitions || []).slice().reverse().find(row => row.kind === 'claimed');
    return latest ? (task.feedback || []).slice().reverse().find(row => row.reportOutcome?.claimSeq === latest.seq)?.reportOutcome || null : null;
  }
  return { normalize, parent, filename, currentReport };
});
