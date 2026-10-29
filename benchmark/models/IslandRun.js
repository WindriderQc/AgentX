'use strict';

/**
 * One island run (docs/ISLAND.md), keyed by its heavy-work queue request id.
 * The queue CLI that runs it reports here; Core's queue stays the authority
 * for the request's state and its release receipt. Never holds a model name,
 * a token or a host address.
 */
const mongoose = require('mongoose');

const memoryFile = new mongoose.Schema({
  bytes: Number,
  truncated: Boolean,
  text: String
}, { _id: false });

const IslandRunSchema = new mongoose.Schema({
  _id: { type: String, required: true },
  dispatchId: { type: String, default: null },
  title: String,
  agent: { type: String, required: true },
  minutes: Number,
  memoryMode: { type: String, enum: ['continue', 'fresh'] },
  world: String,
  // The alias the agent thinks with; never a concrete model.
  model: { type: String, enum: ['agentx-primary', 'netcheck', null], default: null },
  runner: String,
  phase: String,
  outcome: String,
  requestedAt: String,
  startedAt: String,
  endedAt: String,
  timeZone: String,
  resumeCount: { type: Number, default: 0 },
  events: [{ _id: false, at: String, event: String, reason: String, error: String }],
  liveView: { type: new mongoose.Schema({ port: Number, path: String }, { _id: false }), default: null },
  recording: { type: String, default: null },
  memorySource: String,
  // SOUL.md, EPISODIC_MEMORY.jsonl and SEMANTIC_MEMORY.md after the run.
  memory: {
    type: new mongoose.Schema({ soul: memoryFile, episodic: memoryFile, semantic: memoryFile }, { _id: false }),
    default: null
  },
  receipt: {
    type: new mongoose.Schema({ file: String, sha256: String, state: String, runtimeReleased: Boolean }, { _id: false }),
    default: null
  },
  reportedAt: Date
}, { timestamps: true, collection: 'island_runs' });

IslandRunSchema.index({ agent: 1, createdAt: -1 });

module.exports = mongoose.models.IslandRun || mongoose.model('IslandRun', IslandRunSchema);
