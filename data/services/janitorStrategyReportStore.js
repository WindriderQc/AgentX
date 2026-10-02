/**
 * Chunked persistence and hydration of shared-drive strategy reports.
 */
const { ObjectId } = require('mongodb');
const { defaultPolicy } = require('./janitorStrategyPolicy');
const { buildDuplicatePlan } = require('./janitorStrategyDuplicates');

const REPORT_COLLECTION = 'janitor_strategy_reports';
const REPORT_DETAIL_COLLECTION = 'janitor_strategy_report_details';
const REPORT_DETAIL_SCHEMA_VERSION = 1;
const REPORT_DETAIL_MAX_GROUPS = 100;
const REPORT_DETAIL_MAX_BYTES = 4 * 1024 * 1024;

async function getLatestStrategy(db) {
  const report = await db.collection(REPORT_COLLECTION).findOne({}, { sort: { generatedAt: -1 } });
  return hydrateStrategyReport(db, report);
}

function chunkVerifiedEvidence(reportId, groups = []) {
  const chunks = [];
  let current = [];
  let currentBytes = 0;

  const flush = () => {
    if (!current.length) return;
    chunks.push({
      reportId,
      schemaVersion: REPORT_DETAIL_SCHEMA_VERSION,
      ordinal: chunks.length,
      groups: current
    });
    current = [];
    currentBytes = 0;
  };

  for (const group of groups) {
    const groupBytes = Buffer.byteLength(JSON.stringify(group), 'utf8');
    if (current.length && (
      current.length >= REPORT_DETAIL_MAX_GROUPS
      || currentBytes + groupBytes > REPORT_DETAIL_MAX_BYTES
    )) flush();
    current.push(group);
    currentBytes += groupBytes;
  }
  flush();
  return chunks;
}

async function persistStrategyReport(db, report) {
  const reportId = new ObjectId();
  const verifiedEvidence = Array.isArray(report?.evidence?.verifiedDuplicateEvidence)
    ? report.evidence.verifiedDuplicateEvidence
    : [];
  const detailDocs = chunkVerifiedEvidence(reportId, verifiedEvidence);
  const persistedReport = {
    ...report,
    _id: reportId,
    evidence: {
      ...report.evidence,
      verifiedDuplicateEvidence: []
    },
    maintenance: {
      ...report.maintenance,
      proposals: []
    },
    detailStorage: {
      schemaVersion: REPORT_DETAIL_SCHEMA_VERSION,
      collection: REPORT_DETAIL_COLLECTION,
      chunks: detailDocs.length,
      verifiedDuplicateGroups: verifiedEvidence.length,
      proposalsHydratedFrom: 'verifiedDuplicateEvidence'
    }
  };

  try {
    if (detailDocs.length) {
      await db.collection(REPORT_DETAIL_COLLECTION).insertMany(detailDocs, { ordered: true });
    }
    await db.collection(REPORT_COLLECTION).insertOne(persistedReport);
    return reportId;
  } catch (error) {
    if (detailDocs.length) {
      await db.collection(REPORT_DETAIL_COLLECTION).deleteMany({ reportId }).catch(() => {});
    }
    throw error;
  }
}

async function hydrateStrategyReport(db, report) {
  if (!report || report.detailStorage?.schemaVersion !== REPORT_DETAIL_SCHEMA_VERSION) {
    return report;
  }

  const expectedChunks = Math.max(0, Number(report.detailStorage.chunks || 0));
  let detailDocs = [];
  if (expectedChunks > 0) {
    detailDocs = await db.collection(REPORT_DETAIL_COLLECTION)
      .find({ reportId: report._id })
      .sort({ ordinal: 1 })
      .toArray();
  }
  if (detailDocs.length !== expectedChunks) {
    throw new Error(
      `Janitor strategy detail evidence is incomplete: expected ${expectedChunks} chunks, found ${detailDocs.length}`
    );
  }

  const verifiedDuplicateEvidence = detailDocs.flatMap(doc => Array.isArray(doc.groups) ? doc.groups : []);
  const expectedGroups = Math.max(0, Number(report.detailStorage.verifiedDuplicateGroups || 0));
  if (verifiedDuplicateEvidence.length !== expectedGroups) {
    throw new Error(
      `Janitor strategy duplicate evidence is incomplete: expected ${expectedGroups} groups, found ${verifiedDuplicateEvidence.length}`
    );
  }
  const duplicateGroups = verifiedDuplicateEvidence.map(group => ({
    _id: group.sha256,
    size: group.size,
    count: group.count,
    files: group.files
  }));
  const duplicatePlan = buildDuplicatePlan(duplicateGroups, report.policy || defaultPolicy());

  return {
    ...report,
    evidence: { ...report.evidence, verifiedDuplicateEvidence },
    maintenance: { ...report.maintenance, proposals: duplicatePlan.proposals }
  };
}

module.exports = {
  REPORT_COLLECTION,
  REPORT_DETAIL_COLLECTION,
  chunkVerifiedEvidence,
  persistStrategyReport,
  hydrateStrategyReport,
  getLatestStrategy
};
