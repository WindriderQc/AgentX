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
  missing: Boolean,
  text: String
}, { _id: false });

const IslandRunSchema = new mongoose.Schema({
  _id: { type: String, required: true },
  dispatchId: { type: String, default: null },
  title: String,
  agent: { type: String, required: true },
  minutes: Number,
  memoryMode: { type: String, enum: ['continue', 'fresh'] },
  harness: { type: String, enum: ['codex', 'dsh', 'pi'], default: 'codex' },
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
  // Where the agent played: a world the runner simulates (`local`) or a shared world it joins
  // (`remote`, which records itself: `recordDir` is that recording on the world's host).
  worldView: {
    type: new mongoose.Schema({ kind: { type: String, enum: ['local', 'remote'] }, world: String, recordDir: String, instanceId: String, recordingId: String }, { _id: false }),
    default: null
  },
  memorySource: String,
  // The agent's latest thoughts, words and commands while it plays (untrusted text, shown escaped).
  agentMessages: { type: [{ _id: false, at: String, kind: { type: String, enum: ['thought', 'say', 'command'] }, text: String }], default: [] },
  // The four persisted memory files; markdown summary and event journal stay distinct.
  memory: {
    type: new mongoose.Schema({ soul: memoryFile, episodic: memoryFile, episodicMarkdown: memoryFile, semantic: memoryFile }, { _id: false }),
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
