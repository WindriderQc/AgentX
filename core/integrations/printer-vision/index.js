'use strict';

const PRINTER_ID = /^[a-z0-9][a-z0-9-]{0,63}$/;
const STATUSES = new Set(['SAFE', 'WATCH', 'ALERT']);
const CONFIDENCES = new Set(['LOW', 'MEDIUM', 'HIGH']);
const BED_POINT_IDS = new Set([
  'back-left', 'back-center', 'back-right',
  'center-left', 'center', 'center-right',
  'front-left', 'front-center', 'front-right'
]);

const asDate = (value) => {
  if (typeof value !== 'string' || !value.trim()) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
};

const publicStatus = (status) => ({
  printerId: status.printerId,
  printerName: status.printerName,
  monitorState: status.monitorState,
  controlMode: status.controlMode,
  status: status.status,
  confidence: status.confidence,
  observations: status.observations,
  firstAnalysisAt: status.firstAnalysisAt,
  lastAnalysisAt: status.lastAnalysisAt,
  intervalSeconds: status.intervalSeconds,
  model: status.model,
  imageUrl: `/api/printer-vision/status/${encodeURIComponent(status.printerId)}/image`,
  updatedAt: status.updatedAt
});

const publicBedMap = (map) => ({
  id: String(map._id),
  printerId: map.printerId,
  printerName: map.printerName,
  mode: map.mode,
  note: map.note,
  points: map.points,
  createdAt: map.createdAt
});

const validBedPoints = (points) => Array.isArray(points) && points.length === 9
  && points.every(point => point && typeof point === 'object' && !Array.isArray(point)
    && ['x', 'y', 'z'].every(key => point[key] !== null && point[key] !== '' && point[key] !== undefined))
  && new Set(points.map((point) => point.id)).size === 9
  && points.every((point) => BED_POINT_IDS.has(point.id)
    && Number.isFinite(Number(point.x)) && Number.isFinite(Number(point.y))
    && Number.isFinite(Number(point.z)) && Math.abs(Number(point.z)) <= 2);

function getModels(mongoose) {
  const PrinterVisionStatus = mongoose.models.PrinterVisionStatus || mongoose.model(
    'PrinterVisionStatus',
    new mongoose.Schema({
      printerId: { type: String, required: true, unique: true, index: true },
      printerName: { type: String, required: true },
      monitorState: { type: String, enum: ['ACTIVE', 'OFFLINE'], required: true },
      controlMode: { type: String, enum: ['ALERT ONLY'], required: true },
      status: { type: String, enum: ['SAFE', 'WATCH', 'ALERT'], required: true },
      confidence: { type: String, enum: ['LOW', 'MEDIUM', 'HIGH'], required: true },
      observations: { type: String, required: true, maxlength: 2000 },
      firstAnalysisAt: { type: Date, required: true },
      lastAnalysisAt: { type: Date, required: true, index: true },
      intervalSeconds: { type: Number, required: true, min: 15, max: 3600 },
      model: { type: String, required: true, maxlength: 200 },
      imageBase64: { type: String, required: true, maxlength: 2 * 1024 * 1024 }
    }, { timestamps: true })
  );

  const PrinterBedMap = mongoose.models.PrinterBedMap || mongoose.model(
    'PrinterBedMap',
    new mongoose.Schema({
      printerId: { type: String, required: true, index: true },
      printerName: { type: String, required: true },
      mode: { type: String, enum: ['MANUAL'], default: 'MANUAL' },
      note: { type: String, default: '', maxlength: 500 },
      points: [{
        id: { type: String, required: true },
        label: { type: String, required: true },
        x: { type: Number, required: true },
        y: { type: Number, required: true },
        z: { type: Number, required: true }
      }]
    }, { timestamps: true })
  );

  return { PrinterVisionStatus, PrinterBedMap };
}

function register({ app, express, mongoose, standardJsonParser }) {
  const router = express.Router();
  const { PrinterVisionStatus, PrinterBedMap } = getModels(mongoose);

  router.get('/adapter', (_req, res) => res.json({
    ok: true,
    data: { owner: 'aio-ops', extension: 'aio-ops-printer-vision', mode: 'alert-only' }
  }));

  router.post('/status', async (req, res, next) => {
    try {
      const body = req.body || {};
      const printerId = String(body.printerId || '').toLowerCase();
      const firstAnalysisAt = asDate(body.firstAnalysisAt);
      const lastAnalysisAt = asDate(body.lastAnalysisAt);
      const imageBase64 = String(body.imageBase64 || '');
      const intervalSeconds = Number(body.intervalSeconds);

      if (!PRINTER_ID.test(printerId) || !firstAnalysisAt || !lastAnalysisAt
        || firstAnalysisAt > lastAnalysisAt || !String(body.observations || '').trim() || !String(body.model || '').trim()
        || !STATUSES.has(body.status) || !CONFIDENCES.has(body.confidence)
        || !Number.isInteger(intervalSeconds) || intervalSeconds < 15 || intervalSeconds > 3600
        || !/^[A-Za-z0-9+/]+={0,2}$/.test(imageBase64) || imageBase64.length > 2 * 1024 * 1024) {
        return res.status(400).json({ status: 'error', message: 'Invalid printer vision status payload.' });
      }

      const status = await PrinterVisionStatus.findOneAndUpdate(
        { printerId },
        { $set: {
          printerName: String(body.printerName || printerId).slice(0, 200),
          monitorState: body.monitorState === 'OFFLINE' ? 'OFFLINE' : 'ACTIVE',
          controlMode: 'ALERT ONLY',
          status: body.status,
          confidence: body.confidence,
          observations: String(body.observations || '').slice(0, 2000),
          firstAnalysisAt,
          lastAnalysisAt,
          intervalSeconds,
          model: String(body.model || '').slice(0, 200),
          imageBase64
        } },
        { new: true, upsert: true, setDefaultsOnInsert: true, runValidators: true }
      );
      return res.status(201).json({ status: 'success', data: { printer: publicStatus(status) } });
    } catch (error) {
      return next(error);
    }
  });

  router.get('/bed-maps/:printerId', async (req, res, next) => {
    try {
      if (!PRINTER_ID.test(req.params.printerId)) {
        return res.status(400).json({ status: 'error', message: 'Invalid printer id.' });
      }
      const maps = await PrinterBedMap.find({ printerId: req.params.printerId })
        .sort({ createdAt: -1 }).limit(12).lean();
      return res.json({ status: 'success', data: { maps: maps.map(publicBedMap) } });
    } catch (error) {
      return next(error);
    }
  });

  router.post('/bed-maps/:printerId', async (req, res, next) => {
    try {
      const printerId = req.params.printerId;
      const body = req.body || {};
      if (!PRINTER_ID.test(printerId) || !validBedPoints(body.points)) {
        return res.status(400).json({ status: 'error', message: 'A complete 3x3 bed map is required.' });
      }
      const map = await PrinterBedMap.create({
        printerId,
        printerName: String(body.printerName || printerId).slice(0, 200),
        mode: 'MANUAL',
        note: String(body.note || '').slice(0, 500),
        points: body.points.map((point) => ({
          id: point.id,
          label: String(point.label || point.id).slice(0, 40),
          x: Number(point.x), y: Number(point.y), z: Number(point.z)
        }))
      });
      return res.status(201).json({ status: 'success', data: { map: publicBedMap(map) } });
    } catch (error) {
      return next(error);
    }
  });

  router.get('/status/:printerId/image', async (req, res, next) => {
    try {
      if (!PRINTER_ID.test(req.params.printerId)) return res.status(400).json({ status: 'error', message: 'Invalid printer id.' });
      const status = await PrinterVisionStatus.findOne({ printerId: req.params.printerId }).lean();
      if (!status) return res.status(404).json({ status: 'error', message: 'Printer status not found.' });
      return res.type('image/jpeg').send(Buffer.from(status.imageBase64, 'base64'));
    } catch (error) {
      return next(error);
    }
  });

  router.get('/status/:printerId', async (req, res, next) => {
    try {
      if (!PRINTER_ID.test(req.params.printerId)) return res.status(400).json({ status: 'error', message: 'Invalid printer id.' });
      const status = await PrinterVisionStatus.findOne({ printerId: req.params.printerId }).lean();
      if (!status) return res.status(404).json({ status: 'error', message: 'Printer status not found.' });
      return res.json({ status: 'success', data: { printer: publicStatus(status) } });
    } catch (error) {
      return next(error);
    }
  });

  app.use('/api/printer-vision', standardJsonParser, router);
}

module.exports = {
  id: 'aio-ops-printer-vision',
  version: '1.0.0',
  capabilities: ['printer-vision'],
  register
};
