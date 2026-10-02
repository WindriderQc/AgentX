/**
 * ModelContextProbeSnapshot Model
 *
 * Stores benchmark-owned empirical context probe runs for a model on a host.
 * This replaces the need for benchmark to write context-test state back into
 * core-owned modelregistries documents.
 */

const mongoose = require('mongoose');

// Other models Ollama reported loaded beside the probed one for this sample.
// null means the inventory was unreadable, [] means nothing else was loaded.
const CoResidentSchema = new mongoose.Schema({
  model: String,
  size: Number,
  sizeVram: Number,
  contextLength: Number
}, { _id: false });

const ProbeSampleSchema = new mongoose.Schema({
  requestSucceeded: Boolean,
  tokensPerSec: Number,
  promptTokens: Number,
  estimatedPromptTokens: Number,
  promptCoveragePct: Number,
  completionTokens: Number,
  latencyMs: Number,
  vramUsedMiB: Number,
  vramTotalMiB: Number,
  gpuPercent: Number,
  gpuSizeTotal: Number,
  gpuSizeVram: Number,
  ollamaContextLength: Number,
  // Host residency the placement was judged against (a CPU host expects no VRAM).
  residency: { type: String, enum: ['gpu', 'cpu'], default: undefined },
  coResidents: { type: [CoResidentSchema], default: undefined },
  passed: Boolean,
  // 'transport': the request ended without a verdict from Ollama while the
  // model stayed fully GPU-resident at the requested context, so the failure
  // says nothing about capacity. 'capacity': any other failure. null: passed.
  failureKind: { type: String, enum: ['transport', 'capacity', null], default: null },
  failureCode: { type: String, default: null },
  reason: String
}, { _id: false });

const ProbeStepSchema = new mongoose.Schema({
  numCtx: Number,
  requestSucceeded: Boolean,
  failureKind: { type: String, enum: ['transport', 'capacity', null], default: null },
  failureCode: { type: String, default: null },
  tokensPerSec: Number,
  promptTokens: Number,
  estimatedPromptTokens: Number,
  promptCoveragePct: Number,
  minimumPromptCoveragePct: Number,
  repetitionCount: Number,
  tokensPerSecMin: Number,
  tokensPerSecMax: Number,
  tokensPerSecStdDev: Number,
  tokensPerSecCvPct: Number,
  throughputStatistics: { type: mongoose.Schema.Types.Mixed, default: null },
  samples: { type: [ProbeSampleSchema], default: [] },
  completionTokens: Number,
  vramUsedMiB: Number,
  vramTotalMiB: Number,
  gpuPercent: Number,
  gpuSizeTotal: Number,
  gpuSizeVram: Number,
  ollamaContextLength: Number,
  // Host residency the placement was judged against (a CPU host expects no VRAM).
  residency: { type: String, enum: ['gpu', 'cpu'], default: undefined },
  coResidents: { type: [CoResidentSchema], default: undefined },
  latencyMs: Number,
  promptFillPct: Number,
  requestedCompletionTokens: Number,
  minCompletionTokens: Number,
  passed: Boolean,
  degradationPct: Number,
  reason: String
}, { _id: false });

const ModelContextProbeSnapshotSchema = new mongoose.Schema({
  modelName:              { type: String, required: true, index: true },
  hostUrl:                { type: String, required: true, index: true },
  hostId:                 { type: String, required: true, index: true },
  artifactDigest:         { type: String, required: true, index: true },
  runtimeFingerprint:     { type: String, required: true },
  profileDepth:           { type: String, enum: ['quick', 'standard', 'full'], default: 'standard' },
  candidateRepeats:       { type: Number, default: 2 },
  testedNumCtx:           Number,
  // failureKind of the nearest failing candidate above testedNumCtx. With
  // 'transport' the true ceiling is unknown and at least testedNumCtx.
  ceilingFailureKind:     { type: String, enum: ['transport', 'capacity', null], default: null },
  baselineTokensPerSec:   Number,
  atLimitTokensPerSec:    Number,
  degradationPct:         Number,
  degradationThreshold:   Number,
  interactiveDegradationThreshold: Number,
  documentDegradationThreshold: Number,
  performanceKneeDegradationThreshold: Number,
  recommendedInteractiveContext: Number,
  recommendedDocumentContext: Number,
  performanceKneeContext: Number,
  qualityVerifiedContext: { type: Number, default: null },
  qualityContextStatus: { type: String, enum: ['verified', 'unknown'], default: 'unknown' },
  promptFillPct:          Number,
  vramAtLimitMiB:         Number,
  gpuPercentAtLimit:      Number,
  modelTheoreticalMax:    Number,
  resolutionSeedNumCtx:   Number,
  resolutionSeedSource:   String,
  testDurationMs:         Number,
  testedAt: {
    type:    Date,
    default: Date.now,
    index:   true
  },
  status: {
    type:    String,
    enum:    ['running', 'completed', 'failed'],
    default: 'completed'
  },
  error: String,
  authorityStatus: {
    type: String,
    enum: ['pending', 'committed', 'rejected'],
    default: 'pending'
  },
  authorityError: { type: String, default: null },
  authorityWriteId: { type: String, default: null, index: true },
  authorityReconciliationId: { type: String, default: null },
  steps: {
    type:    [ProbeStepSchema],
    default: []
  }
}, {
  collection: 'modelcontextprobesnapshots'
});

ModelContextProbeSnapshotSchema.index(
  { modelName: 1, hostUrl: 1, artifactDigest: 1, testedAt: -1 },
  { name: 'model_context_probe_latest' }
);

module.exports = mongoose.model('ModelContextProbeSnapshot', ModelContextProbeSnapshotSchema);
