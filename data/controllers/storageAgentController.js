'use strict';

// Endpoints used by the native storage collectors and by callers that queue
// work for them.

const storageAgentService = require('../services/storageAgentService');
const { aggregateVolumes, sanitizeVolumeReports } = require('../services/storageVolumes');

const listAgents = async (req, res, next) => {
  try {
    const scanners = await storageAgentService.listScanners(req.app.locals.db);
    res.json({
      status: 'success',
      data: {
        scanners,
        active: scanners.filter(scanner => scanner.active).length,
        sources: storageAgentService.sourceRegistry(),
        volumes: aggregateVolumes(scanners)
      }
    });
  } catch (error) { next(error); }
};

const enqueueAgentScan = async (req, res, next) => {
  try {
    const result = await storageAgentService.enqueueScan(req.app.locals.db, {
      source: req.body?.source,
      hashMode: req.body?.hash_mode,
      hashMaxFiles: req.body?.hash_max_files,
      hashMaxBytes: req.body?.hash_max_bytes
    });
    if (!result.ok) {
      return res.status(result.unavailable ? 503 : (result.conflict ? 409 : 400))
        .json({ status: 'error', message: result.error });
    }
    res.status(202).json({
      status: 'success',
      message: result.coalesced
        ? `Storage scan already ${result.scan.status} for this source; joined it`
        : 'Storage scan queued to native agent',
      data: {
        scan_id: result.scan._id,
        source: result.scan.config.source,
        root: result.scan.config.roots[0],
        hash_mode: result.scan.config.hash_mode,
        coalesced: result.coalesced === true
      }
    });
  } catch (error) { next(error); }
};

const heartbeatAgent = async (req, res, next) => {
  try {
    const { scannerId, hostname, platform, agentVersion, sources = '', scanId } = req.body || {};
    if (!String(scannerId || '').trim()) {
      return res.status(400).json({ status: 'error', message: 'scannerId body field required' });
    }
    const volumes = sanitizeVolumeReports(req.body.volumes, storageAgentService.sourceRegistry());
    const registeredId = await storageAgentService.registerScanner(req.app.locals.db, {
      scannerId, hostname, platform, agentVersion, sources, ...(volumes ? { volumes } : {})
    });
    const data = { scanner_id: registeredId, heartbeat_at: new Date().toISOString() };
    // false tells the collector its scan is no longer running (finished or reaped).
    if (scanId != null) {
      data.scan_refreshed = await storageAgentService.touchScanHeartbeat(req.app.locals.db, scanId, volumes);
    }
    res.json({ status: 'success', data });
  } catch (error) { next(error); }
};

const pollAgentScan = async (req, res, next) => {
  try {
    const { scannerId, hostname, platform, agentVersion, sources = '' } = req.query;
    if (!scannerId) {
      return res.status(400).json({ status: 'error', message: 'scannerId query param required' });
    }
    await storageAgentService.registerScanner(req.app.locals.db, {
      scannerId, hostname, platform, agentVersion, sources
    });
    const acceptedSources = String(sources).split(',').map(value => value.trim()).filter(Boolean);
    const scan = await storageAgentService.claimNextScan(req.app.locals.db, scannerId, acceptedSources);
    const metadataProbePaths = scan
      ? await storageAgentService.listMetadataProbePaths(req.app.locals.db, scan.config.roots[0])
      : [];
    res.json({
      status: 'success',
      data: {
        scan: scan ? {
          scan_id: scan._id,
          source: scan.config.source,
          root: scan.config.roots[0],
          hash_mode: scan.config.hash_mode,
          hash_max_files: scan.config.hash_max_files,
          hash_max_bytes: scan.config.hash_max_bytes,
          metadata_probe_paths: metadataProbePaths
        } : null
      }
    });
  } catch (error) { next(error); }
};

module.exports = { listAgents, enqueueAgentScan, heartbeatAgent, pollAgentScan };
