'use strict';

const IngestJob = require('../../models/IngestJob');
const logger = require('../../config/logger');
const jobManager = require('./ingestJobManager');

function completeIngestScan(jobId, summary) {
  const job = jobManager.getJob(jobId);
  if (!job || job.completedAt) return;

  const { results = [], ...counts } = summary;
  jobManager.completeJob(jobId, counts);
  if (job.status !== 'completed' || counts.failed !== 0
    || counts.processed !== counts.totalCandidates
    || counts.ingested + counts.updated < 1) return;

  const chunksCreated = results
    .filter((result) => result.status === 'ingested' || result.status === 'updated')
    .reduce((total, result) => total + (Number(result.chunkCount) || 0), 0);
  const startedAt = new Date(summary.startedAt).getTime();
  const finishedAt = new Date(summary.finishedAt).getTime();
  const totalTimeMs = Number.isFinite(startedAt) && Number.isFinite(finishedAt)
    ? Math.max(0, finishedAt - startedAt) : 0;

  return IngestJob.create({
    jobId,
    source: 'ingest-scan',
    status: 'success',
    chunksCreated,
    totalTimeMs
  }).catch((error) => logger.warn('Ingest scan freshness receipt failed:', error.message));
}

module.exports = { completeIngestScan };
