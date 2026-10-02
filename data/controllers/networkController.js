const { spawn } = require('child_process');
const { ObjectId } = require('mongodb');
const networkScanner = require('../services/networkScanner');
const networkAgentService = require('../services/networkAgentService');
const { classifyDevices } = require('../services/networkObservation');

// Default scan target — local subnet
const DEFAULT_TARGET = process.env.NETWORK_SCAN_CIDR || '';
// CIDR / IPv4 validation — prevents nmap flag injection via the target field.
const CIDR_RE = /^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}(\/\d{1,2})?$/;

function isMissingDependencyError(error, dependency) {
  return error?.code === 'DEPENDENCY_MISSING' && (!dependency || error.dependency === dependency);
}

// Cheap, side-effect-free probe: is the `nmap` binary present in the container?
// `nmap` is not installed in the default Data image, so the
// Network tab uses this to gate "Scan Now" instead of letting scans 503.
function detectNmap() {
  return new Promise((resolve) => {
    let proc;
    try {
      proc = spawn('nmap', ['--version']);
    } catch {
      return resolve(false);
    }
    let settled = false;
    const done = (present) => { if (!settled) { settled = true; resolve(present); } };
    // Guard against a hung probe — treat as unavailable after a short wait.
    const timer = setTimeout(() => { try { proc.kill('SIGTERM'); } catch {} done(false); }, 3000);
    proc.on('error', () => { clearTimeout(timer); done(false); });        // ENOENT → not installed
    proc.on('close', (code) => { clearTimeout(timer); done(code === 0); });
    // Drain stdio so the child can exit cleanly.
    proc.stdout?.resume();
    proc.stderr?.resume();
  });
}

exports.getCapability = async (req, res) => {
  const nmap = await detectNmap();
  res.json({ status: 'success', data: { nmap } });
};

exports.getAllDevices = async (req, res, next) => {
  try {
    const db = req.app.locals.db;
    const rows = await db.collection('network_devices')
      .find({}).sort({ lastSeen: -1 }).toArray();

    // Each device carries an `observation` (online | recent | historical |
    // never_confirmed) derived from the age of its last sighting against the
    // declared windows; `summary` states the reference time and the windows
    // so every consumer counts "currently online" the same way.
    const { devices, summary } = classifyDevices(rows, { now: new Date() });
    res.json({ status: 'success', results: devices.length, data: { devices, summary } });
  } catch (error) { next(error); }
};

/**
 * POST /scan — primary path is to ENQUEUE a request for a native scanner agent
 * (which can see the real LAN). Only when no agent is reporting do we fall back
 * to in-container nmap (which the data image usually lacks → 503).
 */
exports.scanNetwork = async (req, res, next) => {
  try {
    const db = req.app.locals.db;
    const { target, pruneMissing, source } = req.body || {};
    const scanTarget = target || DEFAULT_TARGET;

    if (!CIDR_RE.test(scanTarget)) {
      return res.status(400).json({ status: 'error', message: 'Invalid target format. Use CIDR notation: x.x.x.x/xx' });
    }

    // Prefer the native-agent path when a scanner is reporting.
    if (await networkAgentService.hasActiveScanner(db)) {
      const job = await networkAgentService.enqueueScanRequest(db, { target: scanTarget, source: source || 'ui' });
      return res.status(202).json({
        status: 'success',
        message: 'Scan queued to network agent',
        data: { jobId: job.jobId, mode: 'agent', target: scanTarget }
      });
    }

    // Fallback: in-container nmap. Throws DEPENDENCY_MISSING when nmap is absent.
    const discoveredDevices = await networkScanner.scanNetwork(scanTarget);
    const summary = await networkAgentService.applyScanResults(db, discoveredDevices, {
      scanSource: 'data-container',
      pruneMissing: pruneMissing === true
    });

    res.json({ status: 'success', message: 'Scan completed', data: { ...summary, mode: 'in-container' } });
  } catch (error) {
    if (isMissingDependencyError(error, 'nmap')) {
      return res.status(503).json({ status: 'error', message: 'Scan unavailable: ' + error.message });
    }

    res.status(500).json({ status: 'error', message: 'Scan failed: ' + error.message });
  }
};

/**
 * POST /scan-results — a native scanner agent posts discovered devices. Token-
 * available on the trusted LAN. Accepts raw nmap XML (parsed here,
 * reusing networkScanner.parseNmapOutput — no nmap binary needed to parse) or a
 * pre-parsed devices[] array.
 */
exports.ingestScanResults = async (req, res, next) => {
  try {
    const db = req.app.locals.db;
    const {
      scannerId, scanSource, requestId,
      format = 'devices', xml, devices, pruneMissing,
      hostname, ip, platform, agentVersion, cidr, capabilities
    } = req.body || {};

    const source = String(scanSource || scannerId || 'agent');

    let deviceList;
    if (format === 'nmap-xml') {
      if (typeof xml !== 'string' || !xml.trim()) {
        return res.status(400).json({ status: 'error', message: 'format=nmap-xml requires a non-empty xml string' });
      }
      deviceList = await networkScanner.parseNmapOutput(xml);
    } else {
      if (!Array.isArray(devices)) {
        return res.status(400).json({ status: 'error', message: 'devices[] required (or format=nmap-xml + xml)' });
      }
      deviceList = devices;
    }

    const summary = await networkAgentService.applyScanResults(db, deviceList, {
      scanSource: source,
      pruneMissing: pruneMissing === true
    });

    // Heartbeat the scanner so the UI sees it as active.
    await networkAgentService.registerScanner(db, {
      scannerId, hostname, ip, platform, agentVersion, cidr, capabilities, lastScanAt: new Date()
    });

    // Complete-on-post: if this answers a queued request, record it.
    if (requestId && scannerId) {
      await networkAgentService.completeScanRequest(db, requestId, scannerId, summary);
    }

    res.json({ status: 'success', message: 'Results ingested', data: { ...summary, scanSource: source } });
  } catch (error) { next(error); }
};

/**
 * GET /scan-requests — a scanner agent polls for pending jobs. This doubles as
 * the scanner heartbeat (registers the agent from query params). Token-gated.
 */
exports.getScanRequests = async (req, res, next) => {
  try {
    const db = req.app.locals.db;
    const { scannerId, hostname, ip, platform, agentVersion, cidr, capabilities } = req.query;
    if (!scannerId) {
      return res.status(400).json({ status: 'error', message: 'scannerId query param required' });
    }

    await networkAgentService.registerScanner(db, { scannerId, hostname, ip, platform, agentVersion, cidr, capabilities });
    const requests = await networkAgentService.getPendingRequestsForScanner(db, scannerId);

    res.json({ status: 'success', results: requests.length, data: { requests } });
  } catch (error) { next(error); }
};

/** GET /agents — registered scanners + active flag, so the UI knows scanning is live. */
exports.getScanAgents = async (req, res, next) => {
  try {
    const db = req.app.locals.db;
    const scanners = await networkAgentService.listScanners(db);
    const active = scanners.filter(s => s.active).length;
    res.json({ status: 'success', results: scanners.length, data: { scanners, active } });
  } catch (error) { next(error); }
};

/** GET /scan-requests/:id — job status for UI polling after enqueue. */
exports.getScanRequestStatus = async (req, res, next) => {
  try {
    const db = req.app.locals.db;
    const job = await networkAgentService.getScanRequest(db, req.params.id);
    if (!job) return res.status(404).json({ status: 'error', message: 'Scan request not found' });
    res.json({ status: 'success', data: job });
  } catch (error) { next(error); }
};

exports.updateDevice = async (req, res, next) => {
  try {
    const db = req.app.locals.db;
    const { id } = req.params;
    const { alias, notes, type, location, known } = req.body;
    if (known !== undefined && typeof known !== 'boolean') {
      return res.status(400).json({ status: 'error', message: 'known must be a boolean' });
    }

    const filter = id.match(/^[0-9a-fA-F]{24}$/)
      ? { _id: new ObjectId(id) }
      : { mac: id };

    const update = {};
    if (alias !== undefined) update.alias = alias;
    if (notes !== undefined) update.notes = notes;
    if (location !== undefined) update.location = location;
    if (type !== undefined) update['hardware.type'] = type;
    // Marking a device known acknowledges it: Core stops treating it as new.
    if (known === true) update.knownAt = new Date();
    const changes = {};
    if (Object.keys(update).length) changes.$set = update;
    if (known === false) changes.$unset = { knownAt: '' };
    if (!Object.keys(changes).length) {
      return res.status(400).json({ status: 'error', message: 'No device field to update' });
    }

    const result = await db.collection('network_devices').findOneAndUpdate(
      filter, changes, { returnDocument: 'after' }
    );

    if (!result) return res.status(404).json({ status: 'error', message: 'Device not found' });
    res.json({ status: 'success', data: { device: result } });
  } catch (error) { next(error); }
};

exports.enrichDevice = async (req, res, next) => {
  try {
    const db = req.app.locals.db;
    const { id } = req.params;

    const filter = id.match(/^[0-9a-fA-F]{24}$/)
      ? { _id: new ObjectId(id) }
      : { mac: id };

    const device = await db.collection('network_devices').findOne(filter);
    if (!device) return res.status(404).json({ status: 'error', message: 'Device not found' });
    if (device.status === 'offline') return res.status(400).json({ status: 'error', message: 'Cannot enrich offline device' });

    const details = await networkScanner.enrichDevice(device.ip);

    if (details) {
      const update = {};
      if (details.hardware?.os) update['hardware.os'] = details.hardware.os;
      if (details.openPorts) update.openPorts = details.openPorts;
      await db.collection('network_devices').updateOne(filter, { $set: update });
    }

    const updated = await db.collection('network_devices').findOne(filter);
    res.json({ status: 'success', data: { device: updated } });
  } catch (error) {
    if (isMissingDependencyError(error, 'nmap')) {
      return res.status(503).json({ status: 'error', message: 'Enrichment unavailable: ' + error.message });
    }

    next(error);
  }
};
