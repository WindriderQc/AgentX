'use strict';

const path = require('path');
const { dataBaseUrl, fetchData: fetchDataService } = require('../../src/services/dataServiceClient');
const { validatePublish } = require('../../../shared/mqttTopicRules');

const REQUEST_TIMEOUT_MS = () => Math.max(1000, Math.min(30000, Number(process.env.DATA_TOOLBOX_TIMEOUT_MS) || 10000));
const SAFE_NAME = /^[a-z0-9_.-]{1,120}$/i;
const JANITOR_DUPLICATE_LIMIT = 30;
const JANITOR_FILE_LIMIT = 8;
const JANITOR_WORK_ITEM_LIMIT = 12;

function collectorPlacement() {
  const raw = process.env.DATA_COLLECTOR_PLACEMENT_JSON;
  if (!raw) return {};
  if (raw.length > 32768) throw new Error('DATA_COLLECTOR_PLACEMENT_JSON exceeds 32 KiB');
  const configured = JSON.parse(raw);
  const result = {};
  for (const kind of ['network', 'storage']) {
    result[kind] = {};
    for (const [id, row] of Object.entries(configured?.[kind] || {}).slice(0, 100)) {
      if (!SAFE_NAME.test(id) || ['__proto__', 'constructor', 'prototype'].includes(id)) continue;
      result[kind][id] = Object.fromEntries(['host', 'supervisor', 'runtime', 'cadence']
        .filter(key => typeof row?.[key] === 'string')
        .map(key => [key, row[key].slice(0, 200)]));
    }
  }
  return result;
}

function boundedInt(value, fallback, min, max) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? Math.min(max, Math.max(min, parsed)) : fallback;
}

function pickQuery(query, rules = {}) {
  const selected = new URLSearchParams();
  for (const [key, rule] of Object.entries(rules)) {
    const raw = query?.[key];
    if (raw === undefined || raw === null || raw === '') continue;
    let value = String(Array.isArray(raw) ? raw[0] : raw);
    if (rule.type === 'int') value = String(boundedInt(value, rule.fallback, rule.min, rule.max));
    else if (rule.values && !rule.values.includes(value)) continue;
    else value = value.slice(0, rule.maxLength || 500);
    selected.set(key, value);
  }
  return selected.toString();
}

function safeName(value, label) {
  const name = String(value || '');
  if (!SAFE_NAME.test(name)) {
    const error = new Error(`Invalid ${label}`);
    error.status = 400;
    throw error;
  }
  return name;
}

const MAC = /^[0-9A-F]{2}(:[0-9A-F]{2}){5}$/;
const STORAGE_SOURCE = /^[a-z0-9][a-z0-9_-]{0,59}$/i;

function fetchData(relativePath, { query = '', timeoutMs = REQUEST_TIMEOUT_MS(), method, payload } = {}) {
  return fetchDataService(relativePath, { query, timeoutMs, method, payload });
}

function relay(relativePath, queryRules) {
  return async (req, res) => {
    try {
      const query = pickQuery(req.query, queryRules);
      const { response, body } = await fetchData(relativePath(req), { query });
      return res.status(response.status).json(body);
    } catch (error) {
      return res.status(error.status || 502).json({
        ok: false,
        status: 'error',
        code: error.name === 'TimeoutError' ? 'DATA_TIMEOUT' : 'DATA_UNAVAILABLE',
        message: error.name === 'TimeoutError' ? 'Data service request timed out' : error.message
      });
    }
  };
}

function numeric(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function optionalNumeric(value) {
  if (value == null || (typeof value === 'string' && !value.trim())) return null;
  return numeric(value, null);
}

function projectJanitorStrategy(body) {
  const report = body?.data?.report ?? body?.report ?? body?.data ?? body ?? {};
  const evidence = report.evidence || {};
  const candidates = evidence.duplicateCandidates || {};
  const outlook = evidence.verificationOutlook || {};
  const organization = report.organizationStrategy || {};
  const maintenance = report.maintenance || {};
  const comparison = report.comparison || {};
  const decisionSupport = report.policyDecisionSupport || {};
  const duplicates = Array.isArray(evidence.verifiedDuplicateEvidence)
    ? evidence.verifiedDuplicateEvidence.slice(0, JANITOR_DUPLICATE_LIMIT)
    : [];
  const workItems = Array.isArray(organization.workItems)
    ? organization.workItems.slice(0, JANITOR_WORK_ITEM_LIMIT)
    : [];

  return {
    generatedAt: report.generatedAt || null,
    status: report.status || 'unavailable',
    mode: report.mode || null,
    scope: {
      canonicalRoots: Array.isArray(report.scope?.canonicalRoots)
        ? report.scope.canonicalRoots.slice(0, 4)
        : [],
      portfolioTotalsDoubleCountDatalake: report.scope?.portfolioTotalsDoubleCountDatalake === true
    },
    summary: {
      verifiedGroups: numeric(evidence.verifiedDuplicateGroups),
      verifiedFiles: numeric(evidence.verifiedDuplicateFiles),
      provenSavingsBytes: numeric(evidence.provenSavingsBytes),
      candidateGroups: numeric(candidates.groups),
      candidateFiles: numeric(candidates.files),
      candidateBytes: numeric(candidates.candidateBytes),
      filesToHash: numeric(candidates.filesToHash ?? outlook.filesToHash),
      bytesToHash: numeric(candidates.bytesToHash ?? outlook.bytesToHash),
      proposals: Array.isArray(maintenance.proposals) ? maintenance.proposals.length : 0,
      workItems: Array.isArray(organization.workItems) ? organization.workItems.length : 0,
      decisionsRequired: Array.isArray(report.decisions_required) ? report.decisions_required.length : 0,
      executableActions: Array.isArray(maintenance.executableActions) ? maintenance.executableActions.length : 0,
      sharedDriveMutations: numeric(report.safety?.sharedDriveMutations)
    },
    policy: {
      duplicateSurvivor: report.policy?.duplicateSurvivor || null,
      backupRetention: report.policy?.backupRetention || null,
      generatedCache: report.policy?.generatedCache || null,
      maintenanceAuthorization: report.policy?.maintenanceAuthorization || 'explicit_per_action',
      updatedAt: report.policy?.updatedAt || null,
      updatedBy: report.policy?.updatedBy || null,
      decisionsRequired: Array.isArray(report.decisions_required)
        ? report.decisions_required.slice(0, 8)
        : []
    },
    verification: {
      status: outlook.status || 'unavailable',
      filesToHash: numeric(outlook.filesToHash ?? candidates.filesToHash),
      bytesToHash: numeric(outlook.bytesToHash ?? candidates.bytesToHash),
      latestCompletedCycle: outlook.latestCompletedCycle ? {
        canonicalRoots: numeric(outlook.latestCompletedCycle.canonicalRoots),
        hashedFiles: numeric(outlook.latestCompletedCycle.hashedFiles),
        hashedBytes: numeric(outlook.latestCompletedCycle.hashedBytes),
        durationSeconds: numeric(outlook.latestCompletedCycle.durationSeconds),
        filesPerSecond: numeric(outlook.latestCompletedCycle.filesPerSecond),
        bytesPerSecond: numeric(outlook.latestCompletedCycle.bytesPerSecond),
        estimatedComparableCyclesLowerBound: numeric(outlook.latestCompletedCycle.estimatedComparableCyclesLowerBound)
      } : null,
      configuredCapacity: outlook.configuredCapacity ? {
        maxFiles: numeric(outlook.configuredCapacity.maxFiles),
        maxBytes: numeric(outlook.configuredCapacity.maxBytes),
        estimatedCyclesLowerBound: numeric(outlook.configuredCapacity.estimatedCyclesLowerBound)
      } : null,
      note: outlook.note || null
    },
    metadata: {
      status: evidence.metadataFirst?.status || 'unavailable',
      indexedFiles: optionalNumeric(evidence.metadataFirst?.indexedFiles),
      indexedBytes: optionalNumeric(evidence.metadataFirst?.indexedBytes),
      organizationReviewAvailable: evidence.metadataFirst?.organizationReviewAvailable === true,
      perRoot: (Array.isArray(evidence.perRoot) ? evidence.perRoot : []).slice(0, 4).map(root => ({
        root: root.root || null,
        totalFiles: numeric(root.totalFiles),
        totalBytes: numeric(root.totalBytes),
        unclassifiedFiles: numeric(root.unclassifiedFiles),
        extensionlessByDesignFiles: numeric(root.extensionlessByDesignFiles),
        missingExtensionUnresolvedFiles: numeric(root.missingExtensionUnresolvedFiles),
        timestampReviewFiles: numeric(root.timestampReviewFiles),
        latestScan: root.latestScan ? {
          status: root.latestScan.status || null,
          finishedAt: root.latestScan.finishedAt || null
        } : null,
        latestHashingScan: root.latestHashingScan ? {
          status: root.latestHashingScan.status || null,
          finishedAt: root.latestHashingScan.finishedAt || null,
          hashMaxFiles: numeric(root.latestHashingScan.hashMaxFiles),
          hashMaxBytes: optionalNumeric(root.latestHashingScan.hashMaxBytes),
          hashedFiles: numeric(root.latestHashingScan.hashedFiles),
          hashedBytes: numeric(root.latestHashingScan.hashedBytes)
        } : null
      }))
    },
    duplicates: duplicates.map(group => {
      const files = Array.isArray(group.files) ? group.files : [];
      return {
        sha256: group.sha256 || null,
        proof: group.proof || null,
        size: numeric(group.size),
        count: numeric(group.count, files.length),
        provenSavingsBytes: numeric(group.provenSavingsBytes),
        files: files.slice(0, JANITOR_FILE_LIMIT).map(file => ({
          path: file.path || null,
          mtime: file.mtime ?? null,
          storageRole: file.storageRole || null
        })),
        filesOmitted: Math.max(0, files.length - JANITOR_FILE_LIMIT)
      };
    }),
    duplicatesShown: duplicates.length,
    duplicatesTotal: numeric(evidence.verifiedDuplicateGroups),
    organization: {
      workItems: workItems.map((item, index) => ({
        rank: index + 1,
        id: item.id || null,
        type: item.type || null,
        root: item.root || null,
        title: item.title || null,
        priority: item.priority || 'review',
        evidence: {
          files: numeric(item.evidence?.files),
          bytes: numeric(item.evidence?.bytes),
          candidateGroups: numeric(item.evidence?.candidateGroups)
        },
        rationale: item.rationale || null,
        disposition: item.disposition || null,
        filesystemMutationAllowed: false
      })),
      workItemsTotal: Array.isArray(organization.workItems) ? organization.workItems.length : 0
    },
    decisionSupport: {
      basis: decisionSupport.basis ? {
        verifiedGroups: numeric(decisionSupport.basis.verifiedGroups),
        verifiedFiles: numeric(decisionSupport.basis.verifiedFiles),
        provenSavingsBytes: numeric(decisionSupport.basis.provenSavingsBytes)
      } : null,
      duplicateSurvivor: decisionSupport.duplicateSurvivor ? {
        maximumGroupsWithDifferentSelection: numeric(decisionSupport.duplicateSurvivor.maximumGroupsWithDifferentSelection)
      } : null,
      backupRetention: decisionSupport.backupRetention ? {
        verifiedGroups: numeric(decisionSupport.backupRetention.verifiedGroups),
        provenSavingsBytes: numeric(decisionSupport.backupRetention.provenSavingsBytes)
      } : null,
      generatedCache: decisionSupport.generatedCache ? {
        verifiedGroups: numeric(decisionSupport.generatedCache.verifiedGroups),
        provenSavingsBytes: numeric(decisionSupport.generatedCache.provenSavingsBytes)
      } : null,
      overlap: decisionSupport.overlap ? {
        verifiedGroups: numeric(decisionSupport.overlap.verifiedGroups),
        provenSavingsBytes: numeric(decisionSupport.overlap.provenSavingsBytes)
      } : null
    },
    comparison: {
      status: comparison.status || 'baseline',
      previousGeneratedAt: comparison.previousGeneratedAt || null,
      deltas: comparison.deltas ? {
        duplicates: {
          verifiedGroups: numeric(comparison.deltas.duplicates?.verifiedGroups),
          verifiedFiles: numeric(comparison.deltas.duplicates?.verifiedFiles),
          provenSavingsBytes: numeric(comparison.deltas.duplicates?.provenSavingsBytes)
        },
        candidates: {
          groups: numeric(comparison.deltas.candidates?.groups),
          files: numeric(comparison.deltas.candidates?.files),
          candidateBytes: numeric(comparison.deltas.candidates?.candidateBytes)
        }
      } : null,
      organization: comparison.organization ? {
        status: comparison.organization.status || 'baseline',
        counts: comparison.organization.counts || null,
        topChanges: (Array.isArray(comparison.organization.topChanges)
          ? comparison.organization.topChanges
          : []).slice(0, JANITOR_WORK_ITEM_LIMIT).map(change => ({
          id: change.id || null,
          title: change.title || null,
          root: change.root || null,
          change: change.change || null,
          filesDelta: numeric(change.filesDelta),
          bytesDelta: numeric(change.bytesDelta)
        }))
      } : null
    },
    maintenance: {
      authorization: maintenance.authorization || 'explicit_per_action',
      approvalRequired: maintenance.approvalRequired !== false,
      executionEndpointCalled: maintenance.executionEndpointCalled === true,
      executableActions: Array.isArray(maintenance.executableActions) ? maintenance.executableActions.length : 0,
      proposalCount: Array.isArray(maintenance.proposals) ? maintenance.proposals.length : 0,
      omittedGroups: numeric(maintenance.omittedGroups)
    },
    safety: {
      sharedDriveMutations: numeric(report.safety?.sharedDriveMutations),
      approvalEndpointsCalled: report.safety?.approvalEndpointsCalled === true,
      deleteMoveArchiveExecuted: report.safety?.deleteMoveArchiveExecuted === true
    }
  };
}

const commonScope = {
  root: { maxLength: 500 },
  category: { maxLength: 60 },
  ext: { maxLength: 30 },
  dirname: { maxLength: 500 },
  storageRole: { maxLength: 60 },
  extensionStatus: { maxLength: 60 },
  timestampQuality: { maxLength: 60 },
  topLevel: { maxLength: 200 }
};

async function buildStatus() {
  const probes = {
    health: '/health',
    resources: '/api/v1/system/resources',
    storage: '/api/v1/storage/summary',
    network: '/api/v1/network/devices',
    liveData: '/api/v1/livedata/feeds',
    databases: '/api/v1/databases/collections',
    janitor: '/api/v1/janitor/profiles'
  };
  const entries = await Promise.all(Object.entries(probes).map(async ([key, route]) => {
    try {
      const result = await fetchData(route, { timeoutMs: 5000 });
      return [key, { ok: result.response.ok && result.body.ok !== false && result.body.status !== 'error', status: result.response.status, data: result.body?.data ?? result.body }];
    } catch (error) {
      return [key, { ok: false, status: 0, error: error.name === 'TimeoutError' ? 'timeout' : error.message }];
    }
  }));
  const sources = Object.fromEntries(entries);
  const healthy = Object.values(sources).filter((source) => source.ok).length;
  return {
    extension: 'aio-ops-data-toolbox',
    version: '1.6.0',
    owner: 'agentx',
    // Three writes are relayed: PATCH /network/devices/:mac (alias and known
    // flag), POST /mqtt/publish (one MQTT message sent by hand) and
    // POST /storage/scans (ask the native collector to read a source again:
    // it refreshes the index and changes nothing on the disks).
    readOnly: false,
    mutationsExposed: true,
    writes: ['network-device-acknowledge', 'mqtt-publish', 'storage-scan-request'],
    filesystemMutationsExposed: false,
    dataService: { baseUrl: dataBaseUrl(), healthy, total: entries.length },
    collectorPlacement: collectorPlacement(),
    sources
  };
}

function register(api) {
  if (api.contractVersion < 2) {
    throw new Error('aio-ops-data-toolbox requires AgentX trusted-extension contract v2');
  }
  dataBaseUrl();
  collectorPlacement();
  const { app, express } = api;
  const publicRoot = path.join(__dirname, 'public');
  const indexFile = path.join(publicRoot, 'index.html');

  app.use('/assets/data-toolbox', express.static(publicRoot, { fallthrough: false, maxAge: '5m' }));
  app.get('/data-toolbox', require('../../src/ui/productShell').surfacePage(app, indexFile, { activePage: 'data-toolbox' }));

  const router = express.Router();
  router.get('/status', async (_req, res) => {
    try { return res.json({ ok: true, status: 'success', data: await buildStatus() }); }
    catch (error) { return res.status(502).json({ ok: false, status: 'error', code: 'DATA_UNAVAILABLE', message: error.message }); }
  });

  router.get('/system/resources', relay(() => '/api/v1/system/resources'));
  router.get('/storage/summary', relay(() => '/api/v1/storage/summary', commonScope));
  router.get('/storage/scans', relay(() => '/api/v1/storage/scans', {
    limit: { type: 'int', fallback: 10, min: 1, max: 50 },
    page: { type: 'int', fallback: 1, min: 1, max: 10000 }
  }));
  router.get('/storage/agents', relay(() => '/api/v1/storage/agents'));
  // One scan by id: a queued scan has no start date yet and sorts after every
  // other in Data's list, so it is followed here.
  router.get('/storage/scans/:scanId', relay((req) => `/api/v1/storage/status/${safeName(req.params.scanId, 'scan id')}`));
  // Third write: ask the native collector to read one configured source again.
  // The body is exactly { source }, and the name must be one Data lists. Only
  // the name is forwarded, so hashing follows Data's defaults. Data answers
  // with the scan queued, or with the one already queued or running for that
  // source (coalesced). A scan reads the disks and refreshes the index.
  router.post('/storage/scans', async (req, res) => {
    const input = req.body;
    const refuse = (status, code, message) => res.status(status).json({ ok: false, status: 'error', code, message });
    if (!input || typeof input !== 'object' || Array.isArray(input)) {
      return refuse(400, 'INVALID_STORAGE_SCAN', 'Expected a JSON object with one field: source');
    }
    const unknown = Object.keys(input).filter((key) => key !== 'source');
    if (unknown.length) return refuse(400, 'INVALID_STORAGE_SCAN', `Unknown field: ${unknown.slice(0, 5).join(', ').slice(0, 200)}`);
    if (typeof input.source !== 'string' || !STORAGE_SOURCE.test(input.source)) {
      return refuse(400, 'INVALID_STORAGE_SCAN', 'source must be the name of a configured storage source');
    }
    let requested = false;
    try {
      const registry = await fetchData('/api/v1/storage/agents');
      const sources = (registry.body.data ?? registry.body).sources;
      if (!registry.response.ok || !sources || typeof sources !== 'object' || Array.isArray(sources)) {
        return refuse(502, 'DATA_UNAVAILABLE', 'Data did not list its storage sources: no scan was requested');
      }
      if (!Object.hasOwn(sources, input.source)) {
        return refuse(400, 'UNKNOWN_STORAGE_SOURCE', `Unknown storage source: ${input.source}`);
      }
      requested = true;
      const { response, body } = await fetchData('/api/v1/storage/agent-scans', { method: 'POST', payload: { source: input.source } });
      return res.status(response.status).json(body);
    } catch (error) {
      const timedOut = error.name === 'TimeoutError';
      return refuse(502, timedOut ? 'DATA_TIMEOUT' : 'DATA_UNAVAILABLE', !timedOut ? error.message
        : requested ? 'Data did not answer in time: the scan may or may not have been queued'
          : 'Data did not answer in time: no scan was requested');
    }
  });
  router.get('/storage/files', relay(() => '/api/v1/storage/files/browse', {
    ...commonScope,
    search: { maxLength: 200 },
    scan_id: { maxLength: 120 },
    hasHash: { values: ['true', 'false'] },
    minSize: { type: 'int', fallback: 0, min: 0, max: Number.MAX_SAFE_INTEGER },
    maxSize: { type: 'int', fallback: Number.MAX_SAFE_INTEGER, min: 0, max: Number.MAX_SAFE_INTEGER },
    sortBy: { values: ['mtime', 'size', 'filename', 'ext', 'dirname', 'created_at', 'updated_at'] },
    sortOrder: { values: ['asc', 'desc'] },
    page: { type: 'int', fallback: 1, min: 1, max: 100000 },
    limit: { type: 'int', fallback: 50, min: 1, max: 100 }
  }));
  router.get('/storage/stats', relay(() => '/api/v1/storage/files/stats', commonScope));
  router.get('/storage/tree', relay(() => '/api/v1/storage/files/tree', {
    root: { maxLength: 500 }, limit: { type: 'int', fallback: 200, min: 1, max: 2000 }
  }));
  router.get('/storage/duplicates', relay(() => '/api/v1/storage/files/duplicates', {
    root: { maxLength: 500 }, method: { values: ['auto', 'hash', 'fuzzy'] }, limit: { type: 'int', fallback: 50, min: 1, max: 100 }
  }));
  router.get('/storage/cleanup', relay(() => '/api/v1/storage/files/cleanup-recommendations', { root: { maxLength: 500 } }));
  router.get('/storage/directory-count', relay(() => '/api/v1/storage/directory-count'));

  router.get('/network/devices', relay(() => '/api/v1/network/devices'));
  router.get('/network/agents', relay(() => '/api/v1/network/agents'));
  router.get('/network/capability', relay(() => '/api/v1/network/capability'));
  // First of the three writes: name a device or mark it known, which acknowledges
  // it as not new. These existing controls follow private LAN human access.
  router.patch('/network/devices/:mac', async (req, res) => {
    const mac = String(req.params.mac || '').toUpperCase();
    const { alias, known } = req.body || {};
    const update = {};
    if (alias !== undefined) update.alias = String(alias).trim().slice(0, 80);
    if (known !== undefined) update.known = known;
    if (!MAC.test(mac) || !Object.keys(update).length || (known !== undefined && typeof known !== 'boolean')) {
      return res.status(400).json({ ok: false, status: 'error', code: 'INVALID_DEVICE_UPDATE',
        message: 'Expected a MAC address and an alias or a boolean known flag' });
    }
    try {
      const { response, body } = await fetchData(`/api/v1/network/devices/${encodeURIComponent(mac)}`,
        { method: 'PATCH', payload: update });
      return res.status(response.status).json(body);
    } catch (error) {
      return res.status(502).json({ ok: false, status: 'error',
        code: error.name === 'TimeoutError' ? 'DATA_TIMEOUT' : 'DATA_UNAVAILABLE', message: error.message });
    }
  });
  router.get('/hardware/collectors', relay(() => '/api/v1/hardware/collectors'));
  router.get('/hardware/latest', relay(() => '/api/v1/hardware/latest', { hostId: { maxLength: 128 } }));
  // Data's own bounds: at most 2 000 samples per read, a non-negative GPU index,
  // a busy threshold in (0, 100]. Data validates the dates and the host id.
  router.get('/hardware/history', relay(() => '/api/v1/hardware/history', {
    hostId: { maxLength: 128 },
    gpuIndex: { type: 'int', fallback: 0, min: 0, max: 255 },
    from: { maxLength: 80 }, to: { maxLength: 80 },
    limit: { type: 'int', fallback: 500, min: 1, max: 2000 }
  }));
  router.get('/hardware/occupancy', relay(() => '/api/v1/hardware/occupancy', {
    hostId: { maxLength: 128 },
    from: { maxLength: 80 }, to: { maxLength: 80 },
    busyAtPct: { type: 'int', fallback: 10, min: 1, max: 100 }
  }));

  router.get('/live-data/feeds', relay(() => '/api/v1/livedata/feeds'));
  router.get('/live-data/state', relay(() => '/api/v1/livedata/state'));
  router.get('/live-data/:feed/latest', relay((req) => `/api/v1/livedata/${safeName(req.params.feed, 'feed')}/latest`, {
    limit: { type: 'int', fallback: 5, min: 1, max: 100 }
  }));
  router.get('/live-data/:feed/history', relay((req) => `/api/v1/livedata/${safeName(req.params.feed, 'feed')}/history`, {
    from: { maxLength: 80 }, to: { maxLength: 80 }, order: { values: ['asc', 'desc'] }, limit: { type: 'int', fallback: 100, min: 1, max: 500 }
  }));

  // The broker monitor Data keeps in memory. `topic` is an MQTT filter that
  // Data validates and applies; a publish topic is at most 256 bytes.
  router.get('/mqtt/status', relay(() => '/api/v1/mqtt/status'));
  router.get('/mqtt/messages', relay(() => '/api/v1/mqtt/messages', {
    since: { type: 'int', fallback: 0, min: 0, max: Number.MAX_SAFE_INTEGER },
    limit: { type: 'int', fallback: 100, min: 1, max: 500 },
    topic: { maxLength: 256 }
  }));
  // Second of the three writes: one MQTT message published by hand, on any topic
  // (the owner's choice). The body is checked here with Data's own rules, and
  // only topic, payload and retain are forwarded. Data refuses when the broker
  // is not connected instead of queueing, and answers after the write.
  router.post('/mqtt/publish', async (req, res) => {
    let message;
    try { message = validatePublish(req.body); }
    catch (error) {
      return res.status(400).json({ ok: false, status: 'error', code: 'INVALID_MQTT_PUBLISH', message: error.message });
    }
    try {
      const { response, body } = await fetchData('/api/v1/mqtt/publish', { method: 'POST', payload: message });
      return res.status(response.status).json(body);
    } catch (error) {
      const timedOut = error.name === 'TimeoutError';
      return res.status(502).json({ ok: false, status: 'error', code: timedOut ? 'DATA_TIMEOUT' : 'DATA_UNAVAILABLE',
        message: timedOut ? 'Data did not answer in time: the message may or may not have been sent' : error.message });
    }
  });

  router.get('/databases/collections', relay(() => '/api/v1/databases/collections'));
  router.get('/databases/collections/:name/stats', relay((req) => `/api/v1/databases/collections/${safeName(req.params.name, 'collection')}/stats`));
  router.get('/databases/collections/:name/documents', relay((req) => `/api/v1/databases/collections/${safeName(req.params.name, 'collection')}`, {
    page: { type: 'int', fallback: 1, min: 1, max: 100000 },
    limit: { type: 'int', fallback: 25, min: 1, max: 100 },
    sort: { values: ['asc', 'desc'] },
    q: { maxLength: 2000 }
  }));
  router.get('/databases/collections/:name/documents/:id', relay((req) => `/api/v1/databases/collections/${safeName(req.params.name, 'collection')}/${safeName(req.params.id, 'document id')}`));

  router.get('/janitor/profiles', relay(() => '/api/v1/janitor/profiles'));
  router.get('/janitor/profiles/:id/runs', relay((req) => `/api/v1/janitor/profiles/${safeName(req.params.id, 'profile id')}/runs`, {
    page: { type: 'int', fallback: 1, min: 1, max: 100000 }, limit: { type: 'int', fallback: 20, min: 1, max: 100 }
  }));
  router.get('/janitor/runs/:id', relay((req) => `/api/v1/janitor/profiles/runs/${safeName(req.params.id, 'run id')}`));
  router.get('/janitor/dedup-report', relay(() => '/api/v1/janitor/dedup-report', {
    group_offset: { type: 'int', fallback: 0, min: 0, max: Number.MAX_SAFE_INTEGER },
    group_limit: { type: 'int', fallback: 100, min: 1, max: 1000 }
  }));
  router.get('/janitor/policies', relay(() => '/api/v1/janitor/policies'));
  router.get('/janitor/strategy/latest', async (_req, res) => {
    try {
      const { response, body } = await fetchData('/api/v1/janitor/profiles/shared-drive/strategy/latest');
      // No report generated yet is an empty state, not a failure of the tab.
      if (response.status === 404) {
        return res.json({ ok: true, status: 'success', data: { ...projectJanitorStrategy({}), available: false } });
      }
      if (!response.ok) return res.status(response.status).json(body);
      return res.json({ ok: true, status: 'success', data: projectJanitorStrategy(body) });
    } catch (error) {
      return res.status(error.status || 502).json({
        ok: false,
        status: 'error',
        code: error.name === 'TimeoutError' ? 'DATA_TIMEOUT' : 'DATA_UNAVAILABLE',
        message: error.name === 'TimeoutError' ? 'Data service request timed out' : error.message
      });
    }
  });
  router.get('/janitor/strategy/latest/raw', relay(() => '/api/v1/janitor/profiles/shared-drive/strategy/latest'));

  app.use('/api/data-toolbox', router);
}

module.exports = {
  id: 'aio-ops-data-toolbox',
  version: '1.6.0',
  capabilities: ['data-toolbox-ui', 'data-readonly-projection', 'network-device-acknowledge', 'mqtt-publish', 'storage-scan-request'],
  register,
  boundedInt,
  pickQuery,
  safeName,
  dataBaseUrl,
  buildStatus,
  collectorPlacement,
  projectJanitorStrategy
};
