'use strict';

const mongoose = require('mongoose');

// One runtime topology switch (#360, phase 4): a durable state machine
// requested -> draining -> actuating -> loading -> verifying -> active, or a
// terminal refused / rolled_back / uncertain. Idempotent by requestId.
const STATES = Object.freeze([
  'requested', 'draining', 'actuating', 'loading', 'verifying', 'rolling_back',
  'active', 'refused', 'rolled_back', 'uncertain'
]);
const TERMINAL_STATES = Object.freeze(['active', 'refused', 'rolled_back', 'uncertain']);

const TransitionSchema = new mongoose.Schema({
  state: { type: String, enum: STATES, required: true },
  at: { type: Date, required: true },
  detail: { type: String, default: null, maxlength: 500 }
}, { _id: false });

const RuntimeTopologySwitchSchema = new mongoose.Schema({
  requestId: { type: String, required: true, unique: true, maxlength: 120 },
  groupId: { type: String, required: true, maxlength: 64 },
  targetMode: { type: String, required: true, maxlength: 64 },
  expectedActiveMode: { type: String, default: null, maxlength: 64 },
  fromMode: { type: String, default: null, maxlength: 64 },
  principal: { type: String, required: true, maxlength: 200 },
  source: { type: String, default: 'api', maxlength: 40 },
  state: { type: String, enum: STATES, required: true, default: 'requested' },
  transitions: { type: [TransitionSchema], default: [] },
  reason: { type: String, default: null, maxlength: 120 },
  message: { type: String, default: null, maxlength: 1000 },
  blockers: { type: [mongoose.Schema.Types.Mixed], default: [] },
  hosts: { type: [String], default: [] },
  lease: {
    leaseId: { type: String, default: null },
    generation: { type: String, default: null },
    requestId: { type: String, default: null },
    state: { type: String, default: null }
  },
  actuator: {
    activate: { type: mongoose.Schema.Types.Mixed, default: null },
    confirm: { type: mongoose.Schema.Types.Mixed, default: null },
    rollback: { type: mongoose.Schema.Types.Mixed, default: null },
    status: { type: mongoose.Schema.Types.Mixed, default: null }
  },
  verification: { type: mongoose.Schema.Types.Mixed, default: null },
  restore: { type: mongoose.Schema.Types.Mixed, default: null },
  // Operator recovery of an uncertain switch (lease recovered, mode recorded).
  recovery: { type: mongoose.Schema.Types.Mixed, default: null },
  timings: { type: mongoose.Schema.Types.Mixed, default: {} },
  driverHeartbeatAt: { type: Date, default: null },
  finishedAt: { type: Date, default: null }
}, { collection: 'runtime_topology_switches', timestamps: true });

RuntimeTopologySwitchSchema.index({ groupId: 1, createdAt: -1 });
RuntimeTopologySwitchSchema.index({ state: 1 });

const model = mongoose.models.RuntimeTopologySwitch
  || mongoose.model('RuntimeTopologySwitch', RuntimeTopologySwitchSchema);

module.exports = model;
module.exports.STATES = STATES;
module.exports.TERMINAL_STATES = TERMINAL_STATES;
