const mongoose = require('mongoose');

// Singleton document describing the platform backup scheduler's occurrence
// state. One occurrence is one cron (or interval) slot; a slot is taken
// atomically, run once, retried on retryable layers only, and never re-run
// after a process restart. See src/services/backupSchedulerState.js.
const BACKUP_SCHEDULER_STATE_ID = 'backup-scheduler';
const OCCURRENCE_STATES = Object.freeze(['due', 'running', 'success', 'partial', 'failed']);
const LAST_SUCCESS_SOURCES = Object.freeze(['recorded', 'reconciled_from_artifact', 'artifact']);

const LayerResultSchema = new mongoose.Schema({
  name: { type: String, required: true, maxlength: 40 },
  status: { type: String, enum: ['success', 'error'], required: true },
  durationMs: { type: Number, default: 0 },
  artifact: { type: String, default: null, maxlength: 255 },
  error: { type: String, default: null, maxlength: 500 },
  code: { type: String, default: null, maxlength: 64 },
  retryable: { type: Boolean, default: true },
  carriedForward: { type: Boolean, default: false },
  reconciled: { type: Boolean, default: false }
}, { _id: false });

const BackupSchedulerStateSchema = new mongoose.Schema({
  _id: { type: String, default: BACKUP_SCHEDULER_STATE_ID },
  version: { type: Number, default: 0 },
  anchor: { type: String, enum: ['cron', 'interval'], default: 'cron' },
  cron: { type: String, default: '', maxlength: 120 },
  timezone: { type: String, default: '', maxlength: 80 },
  occurrence: {
    dueAt: { type: Date, default: null },
    state: { type: String, enum: OCCURRENCE_STATES, default: 'due' },
    reason: { type: String, default: '', maxlength: 60 },
    attempts: { type: Number, default: 0 },
    cycleMode: { type: String, enum: ['full', 'retry', null], default: null },
    owner: { type: String, default: '', maxlength: 160 },
    startedAt: { type: Date, default: null },
    finishedAt: { type: Date, default: null },
    results: { type: [LayerResultSchema], default: [] },
    retry: {
      nextAt: { type: Date, default: null },
      only: { type: [String], default: [] },
      dropped: { type: Boolean, default: false },
      droppedReason: { type: String, default: '', maxlength: 200 }
    }
  },
  lastAttemptAt: { type: Date, default: null },
  lastSuccessAt: { type: Date, default: null },
  lastSuccessSource: { type: String, enum: [...LAST_SUCCESS_SOURCES, null], default: null }
}, { timestamps: true });

const BackupSchedulerState = mongoose.models.BackupSchedulerState
  || mongoose.model('BackupSchedulerState', BackupSchedulerStateSchema);

module.exports = BackupSchedulerState;
module.exports.BACKUP_SCHEDULER_STATE_ID = BACKUP_SCHEDULER_STATE_ID;
module.exports.OCCURRENCE_STATES = OCCURRENCE_STATES;
module.exports.LAST_SUCCESS_SOURCES = LAST_SUCCESS_SOURCES;
