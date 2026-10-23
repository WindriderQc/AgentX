'use strict';
const { createHash } = require('node:crypto');
const SCHEMA = 'agentx.report-material-progress/v1';
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');

// Report bytes contain notes and administrative receipts. Only accepted source
// coverage may justify another execution. Wording and array order are inert.
function units(coverage) {
  if (!coverage || !/^[a-f0-9]{64}$/.test(coverage.inventorySha256 || '') || !Array.isArray(coverage.documents)) return null;
  const result = new Set();
  for (const row of coverage.documents) {
    if (!row || typeof row.path !== 'string' || !/^[a-f0-9]{64}$/.test(row.sha256 || '')
      || !Array.isArray(row.evidence) || row.evidence.some(ref => !ref || typeof ref.path !== 'string'
        || !/^[a-f0-9]{64}$/.test(ref.sha256 || '') || !Number.isSafeInteger(ref.line) || ref.line < 1)) return null;
    if (row.ranges !== undefined && (!Array.isArray(row.ranges) || row.ranges.some((range, index) =>
      !Array.isArray(range) || range.length !== 2 || !range.every(Number.isSafeInteger)
      || range[0] < 1 || range[1] < range[0] || (index && range[0] <= row.ranges[index - 1][1])))) return null;
    if (row.state === 'reviewed') result.add(JSON.stringify(['reviewed', row.path, row.sha256]));
    for (const ref of row.evidence || [])
      result.add(JSON.stringify(['source', row.path, ref.path, ref.sha256, ref.line]));
    const merged = [];
    for (const range of row.ranges || []) {
      const last = merged.at(-1);
      if (last && range[0] <= last[1] + 1) last[1] = Math.max(last[1], range[1]);
      else merged.push([...range]);
    }
    for (const range of merged) result.add(JSON.stringify(['range', row.path, row.sha256, ...range]));
  }
  return [...result].sort();
}

function compare(current, parent = null) {
  const after = units(current.coverage);
  const before = parent ? units(parent.coverage) : [];
  const sameScope = !parent || (parent.pipelineId === current.pipelineId && parent.taskId === current.taskId
    && parent.sourceCommit === current.sourceCommit && parent.specSha256 === current.specSha256
    && parent.coverage?.inventorySha256 === current.coverage?.inventorySha256);
  if (!after || !before || !sameScope) return { schema: SCHEMA, verified: false, advanced: false,
    reason: 'coverage_comparison_unverified' };
  const previous = new Set(before);
  const addedUnits = after.filter(unit => !previous.has(unit)).length;
  return { schema: SCHEMA, verified: true, advanced: addedUnits > 0, addedUnits,
    beforeSha256: digest(before), afterSha256: digest(after) };
}

async function read(current) {
  if (!current) return { schema: SCHEMA, verified: false, advanced: false, reason: 'report_run_unavailable' };
  let parent = null;
  if (current.parentRequestId) {
    parent = await require('./pipelineReportCheckpoint').find(current.pipelineId, current.parentRequestId);
    if (!parent) return { schema: SCHEMA, verified: false, advanced: false, reason: 'parent_coverage_unavailable' };
  }
  return compare(current, parent);
}
module.exports = { SCHEMA, units, compare, read };
