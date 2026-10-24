const mongoose = require('mongoose');
const { PlanRevisionSchema } = require('./PipelineTaskPlanSchema');

// Product-owned task queue. External boards consume the bounded HTTP API.
const FeedbackSchema = new mongoose.Schema({
  at: { type: Date, default: Date.now },
  by: String,
  text: String,
  workerOutcome: { type: mongoose.Schema.Types.Mixed, default: undefined },
  reportOutcome: { type: mongoose.Schema.Types.Mixed, default: undefined },
  reportAcceptance: { type: mongoose.Schema.Types.Mixed, default: undefined },
}, { _id: false });

// Why a task was closed without being delivered. Set once by the guarded
// supersede action; the matching feedback entry keeps the immutable history.
const ResolutionSchema = new mongoose.Schema({
  kind: { type: String, enum: ['superseded'], required: true },
  supersededBy: { type: String, required: true },
  reason: { type: String, required: true },
  by: { type: String, required: true },
  at: { type: Date, required: true },
}, { _id: false });

const AutomationBudgetSchema = new mongoose.Schema({
  maxDurationMs: { type: Number, required: true, min: 1 },
  maxAttempts: { type: Number, required: true, min: 1, max: 10 },
  maxCostNanodollars: { type: Number, required: true, min: 0 },
}, { _id: false });

const AutomationIntentSchema = new mongoose.Schema({
  schema: { type: String, required: true },
  mode: { type: String, enum: ['manual', 'review_only'], required: true },
  policyRef: { type: String, default: null },
  dataClassification: {
    type: String,
    enum: ['public', 'internal', 'confidential', 'restricted'],
    default: null,
  },
  operations: { type: [String], default: undefined },
  scope: { type: [String], default: undefined },
  sourceFiles: { type: [String], default: undefined },
  lockKeys: { type: [String], default: undefined },
  executionProfile: { type: String, default: null },
  verificationProfile: { type: String, default: null },
  budgets: { type: AutomationBudgetSchema, default: undefined },
  humanGates: { type: [String], default: undefined },
  fingerprint: { type: String, required: true },
}, { _id: false });

const AutomationLeaseSchema = new mongoose.Schema({
  leaseId: { type: String, required: true },
  assignee: { type: String, required: true },
  acquiredAt: { type: Date, required: true },
  heartbeatAt: { type: Date, required: true },
  expiresAt: { type: Date, required: true },
  durationMs: { type: Number, required: true, min: 1 },
  attempt: { type: Number, required: true, min: 1 },
  // Optional one-shot launch request that produced this claim (UUID). It is a
  // displayable reference only; it never authorizes a mutation.
  dispatchRequestId: { type: String, default: undefined },
}, { _id: false });

const ElectricityTariffEvidenceSchema = new mongoose.Schema({
  currency: { type: String, required: true, match: /^[A-Z]{3}$/ },
  rateNanoCurrencyUnitsPerKwh: { type: Number, required: true, min: 0 },
  estimatedCostNanoCurrencyUnits: { type: Number, required: true, min: 0 },
  source: { type: String, required: true },
  evidenceFingerprint: { type: String, required: true, match: /^[a-f0-9]{64}$/ },
}, { _id: false });

const LocalEnergyEvidenceSchema = new mongoose.Schema({
  measurementScope: {
    type: String,
    enum: ['gpu-incremental-lower-bound'],
    required: true,
  },
  energyMillijoules: { type: Number, required: true, min: 0 },
  measurementDurationMs: { type: Number, required: true, min: 1 },
  sampleCount: { type: Number, required: true, min: 1 },
  baselineMilliwatts: { type: Number, required: true, min: 0 },
  source: { type: String, required: true },
  evidenceFingerprint: { type: String, required: true, match: /^[a-f0-9]{64}$/ },
  tariff: { type: ElectricityTariffEvidenceSchema, default: undefined },
}, { _id: false });

const AutomationAttemptEvidenceSchema = new mongoose.Schema({
  schema: { type: String, required: true },
  verification: {
    status: { type: String, enum: ['passed', 'failed', 'unknown'], required: true },
    durationMs: { type: Number, min: 0, default: null },
    testsPassed: { type: Number, min: 0, default: null },
    testsFailed: { type: Number, min: 0, default: null },
  },
  changes: {
    filesChanged: { type: Number, min: 0, default: null },
    bytesChanged: { type: Number, min: 0, default: null },
  },
  usage: {
    durationMs: { type: Number, min: 0, default: null },
    costNanodollars: { type: Number, min: 0, default: null },
    costKind: { type: String, enum: ['provider-spend', 'session-estimate'], default: null },
    costSource: { type: String, default: null },
    costEvidenceFingerprint: { type: String, default: null },
    inputTokens: { type: Number, min: 0, default: undefined },
    outputTokens: { type: Number, min: 0, default: undefined },
    cacheReadTokens: { type: Number, min: 0, default: undefined },
    totalTokens: { type: Number, min: 0, default: undefined },
    modelCalls: { type: Number, min: 0, default: undefined },
    effectiveModel: { type: String, default: undefined },
    tokenStatus: { type: String, enum: ['complete', 'partial', 'unknown'], default: undefined },
    costStatus: { type: String, enum: ['complete', 'partial', 'unknown'], default: undefined },
    localEnergy: { type: LocalEnergyEvidenceSchema, default: undefined },
  },
  repository: { type: mongoose.Schema.Types.Mixed, default: undefined },
  routing: { type: mongoose.Schema.Types.Mixed, default: undefined },
  inference: { type: mongoose.Schema.Types.Mixed, default: undefined },
  // Public, bounded projection of the private runner ledger. The shared
  // contract strips prompts, commands, verifier output and workspace paths.
  codeSteps: { type: mongoose.Schema.Types.Mixed, default: undefined },
  // Additive multi-host graph projection. Core validates the complete public
  // shape before this terminal snapshot is stored.
  codeStepGraph: { type: mongoose.Schema.Types.Mixed, default: undefined },
  // This subdocument must retain the public field named `schema`. Mongoose's
  // primitive-array caster collides with that field name while validating an
  // explicit `failureCodes: []`, so preserve the already-normalized contract
  // value as Mixed and validate its exact safe shape here.
  failureCodes: {
    type: mongoose.Schema.Types.Mixed,
    default: () => [],
    validate: {
      validator: (value) => Array.isArray(value)
        && value.every((code) => typeof code === 'string'),
      message: 'failureCodes must be an array of strings',
    },
  },
  workerReceiptFingerprint: { type: String, default: null },
  source: { type: String, default: null },
}, { _id: false });

const AutomationAttemptSchema = new mongoose.Schema({
  leaseId: { type: String, required: true },
  assignee: { type: String, required: true },
  attempt: { type: Number, required: true, min: 1 },
  dispatchRequestId: { type: String, default: undefined },
  planRevision: { type: Number, min: 1, default: undefined },
  planFingerprint: { type: String, match: /^[a-f0-9]{64}$/, default: undefined },
  acquiredAt: { type: Date, required: true },
  heartbeatAt: { type: Date, required: true },
  expiresAt: { type: Date, required: true },
  completedAt: { type: Date, default: null },
  finalState: {
    type: String,
    enum: ['active', 'review', 'blocked', 'done', 'partial', 'released', 'expired'],
    default: 'active',
  },
  evidence: { type: AutomationAttemptEvidenceSchema, default: undefined },
  resultRequestFingerprint: { type: String, match: /^[a-f0-9]{64}$/, default: undefined },
  reviewedAt: { type: Date, default: null },
  reviewOutcome: {
    type: String,
    enum: ['pending', 'accepted', 'requeued', 'rejected'],
    default: 'pending',
  },
}, { _id: false });

// One status transition, written by the same single-document update that
// changes `status` (see pipelineTaskTransitions.js). `actor.declared` is what
// the caller said; `actor.authenticated` stays null until Core authenticates
// pipeline callers. Documents created before this log simply have none.
const TaskTransitionSchema = new mongoose.Schema({
  schema: { type: String, required: true },
  seq: { type: Number, required: true, min: 1 },
  at: { type: Date, required: true },
  from: { type: String, default: null },
  to: { type: String, required: true },
  kind: { type: String, required: true },
  actor: {
    declared: { type: String, default: null },
    authenticated: { type: String, default: null },
    channel: { type: String, required: true },
  },
  attempt: { type: Number, default: null },
  reason: { type: String, default: null },
  evidence: {
    taskRef: { type: String, default: null },
    attemptRef: { type: String, default: null },
    leaseRef: { type: String, default: null },
    dispatchRequestId: { type: String, default: null },
    supersededByRef: { type: String, default: null },
  },
}, { _id: false });

const PipelineTaskSchema = new mongoose.Schema({
  intake: { type: require('./TaskIntakeSchema'), default: undefined },
  origin: { type: String, default: undefined },
  pipelineId: { type: String, required: true, unique: true, index: true }, // e.g. "0307"
  title: { type: String, required: true },
  spec: { type: String, default: '' },                 // full markdown body (optional)
  service: { type: String, default: '' },
  status: {
    type: String,
    enum: ['queued', 'in_progress', 'review', 'blocked', 'done'],
    default: 'queued',
    index: true,
  },
  assignee: { type: String, default: null, index: true },
  heartbeatAt: { type: Date, default: null },
  epic: { type: String, default: '' },                 // ROADMAP section heading
  priority: { type: Number, min: 1, max: 5, default: 3, index: true },
  dependsOn: { type: [String], default: [] },          // pipelineIds
  notBefore: { type: Date, default: null, index: true },
  dueAt: { type: Date, default: null, index: true },
  personalRepeat: { type: mongoose.Schema.Types.Mixed, default: undefined },
  personalRepeatAnchor: { type: Date, default: undefined },
  personalLastCompletedOccurrence: { type: Date, default: undefined },
  personalCaptureId: { type: String, default: undefined },
  personalCaptureFingerprint: { type: String, default: undefined },
  // Personal tasks only: the day of the activity the task serves. Once it has
  // passed the task is pointless, even when its own dueAt was never met.
  relevantUntil: { type: Date, default: undefined },
  personalReview: {
    type: new mongoose.Schema({
      state: { type: String, enum: ['pending', 'accepted', 'dismissed'], required: true },
      reason: { type: String, enum: ['email', 'platform', 'assistant'], default: undefined },
      reviewedAt: { type: Date, default: null },
    }, { _id: false }),
    default: undefined,
  },
  // Household routines use the same canonical task lifecycle and ID sequence.
  // Domain fields are optional so engineering/personal tasks stay unchanged.
  profileId: { type: String, index: true },
  cadence: { type: String, enum: ['once', 'daily', 'weekly', 'interval'] },
  // Interval routines only (#863): days between repeats, and an optional
  // winter-season interval (FAMILY_WINTER_SEASON).
  intervalDays: Number,
  winterIntervalDays: Number,
  // What a family chore is about, e.g. plant:<id> (#869).
  subjectRef: { type: String, index: true },
  stars: Number,
  completionCount: Number,
  checkedInAt: Date,
  lastCompletedAt: Date,
  familyCancelled: Boolean,
  risk: {
    type: String,
    enum: ['', 'low', 'medium', 'high', 'critical'],
    default: '',
  },
  automation: { type: AutomationIntentSchema, default: undefined },
  automationAttemptCount: { type: Number, min: 0, default: 0 },
  automationLease: { type: AutomationLeaseSchema, default: undefined },
  codingCapacity: { type: mongoose.Schema.Types.Mixed, default: undefined },
  codingCapacityRecovery: { type: mongoose.Schema.Types.Mixed, default: undefined },
  codingAutonomy: { type: mongoose.Schema.Types.Mixed, default: undefined },
  // Core-owned durable state for one multi-host code-step graph. The pure DAG
  // service validates every complete replacement before this Mixed value is
  // committed with a revision-fenced single-document update.
  codeStepDag: { type: mongoose.Schema.Types.Mixed, default: undefined },
  // Bounded public graph summaries retained when a terminal DAG is atomically
  // replaced by a later autonomous correction run.
  codeStepDagHistory: { type: [mongoose.Schema.Types.Mixed], default: undefined },
  codingResult: { type: mongoose.Schema.Types.Mixed, default: undefined },
  codingReportAuthority: { type: mongoose.Schema.Types.Mixed, default: undefined },
  // Automatic continuation runs of a private report (#835), one per parent outcome.
  reportContinuation: { type: mongoose.Schema.Types.Mixed, default: undefined },
  // Owner's one-click resume (#878): the Core-owned campaign and its estimate.
  reportResume: { type: mongoose.Schema.Types.Mixed, default: undefined },
  reportHistoryReceipts: { type: [mongoose.Schema.Types.Mixed], default: undefined },
  reportCheckpointArchive: { type: mongoose.Schema.Types.Mixed, default: undefined },
  reportPreflightReceipts: { type: [mongoose.Schema.Types.Mixed], default: undefined },
  automationAttempts: { type: [AutomationAttemptSchema], default: [] },
  deliverablePermitSeq: { type: Number, min: 0, default: 0 },
  deliverableIntents: { type: [mongoose.Schema.Types.Mixed], default: undefined },
  deliverableRegistryRevision: { type: Number, min: 0, default: 0 },
  manualReportPermitSeq: { type: Number, min: 1, default: undefined },
  planningItemIds: [{
    type: mongoose.Schema.Types.ObjectId,
    ref: 'PlanningItem',
    index: true,
  }],
  scheduleEntryIds: { type: [String], default: [] },   // ClusterScheduleEntry.sourceId
  feedback: { type: [FeedbackSchema], default: [] },
  resolution: { type: ResolutionSchema, default: undefined },
  transitions: { type: [TaskTransitionSchema], default: undefined },
  transitionSeq: { type: Number, min: 1, default: undefined },
  planRevisions: { type: [PlanRevisionSchema], default: undefined },
  planRevision: { type: Number, min: 1, default: undefined },
  source: { type: String, default: 'api' },
  // Optional caller-owned idempotency key. The compound partial index lets a
  // reviewed memory candidate safely retry task creation after a lost reply.
  sourceKey: { type: String, default: null, maxlength: 200 },
  workLinks: { type: require('./TaskWorkLinksSchema'), default: undefined },
  workAdmission: { type: mongoose.Schema.Types.Mixed, default: undefined },
}, { timestamps: true });

PipelineTaskSchema.index(
  { source: 1, sourceKey: 1 },
  { unique: true, partialFilterExpression: { sourceKey: { $type: 'string' } } }
);
PipelineTaskSchema.index({ 'automation.mode': 1, status: 1, priority: 1 });
PipelineTaskSchema.index({ personalCaptureId: 1 }, { unique: true, partialFilterExpression: { personalCaptureId: { $type: 'string' } } });
PipelineTaskSchema.index({ 'automationLease.expiresAt': 1 });
PipelineTaskSchema.index({ 'automationAttempts.acquiredAt': 1 });
PipelineTaskSchema.index({ 'workLinks.entries.key': 1 });
PipelineTaskSchema.index({ 'workAdmission.referenceKey': 1 });
PipelineTaskSchema.index({ 'workAdmission.requestId': 1 }, { unique: true,
  partialFilterExpression: { 'workAdmission.requestId': { $type: 'string' } } });

module.exports = mongoose.model('PipelineTask', PipelineTaskSchema);
