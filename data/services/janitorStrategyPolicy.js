/**
 * Shared-drive strategy policy: choices, validation and persistence.
 */
const POLICY_COLLECTION = 'janitor_shared_drive_policies';
const POLICY_ID = 'shared-drive';
const SHARED_ROOTS = Object.freeze(['/mnt/media', '/mnt/datalake']);

const POLICY_CHOICES = Object.freeze({
  duplicateSurvivor: Object.freeze(['canonical_active', 'newest', 'oldest']),
  backupRetention: Object.freeze(['immutable_archive', 'disaster_recovery', 'staging']),
  generatedCache: Object.freeze(['preserve', 'review_rebuildable'])
});

const DECISION_DEFINITIONS = Object.freeze([
  Object.freeze({
    field: 'duplicateSurvivor',
    question: 'Which copy should survive inside a current SHA-256 duplicate group?',
    choices: POLICY_CHOICES.duplicateSurvivor
  }),
  Object.freeze({
    field: 'backupRetention',
    question: 'Are backup-like trees immutable archives, disaster-recovery retention, or staging?',
    choices: POLICY_CHOICES.backupRetention
  }),
  Object.freeze({
    field: 'generatedCache',
    question: 'Should generated caches be preserved or admitted to rebuildable review proposals?',
    choices: POLICY_CHOICES.generatedCache
  })
]);

function defaultPolicy() {
  return {
    version: 1,
    duplicateSurvivor: null,
    backupRetention: null,
    generatedCache: null,
    // The user-level goal already fixes this invariant. There is deliberately
    // no automatic-execution choice in the policy schema.
    maintenanceAuthorization: 'explicit_per_action'
  };
}

function publicPolicy(doc) {
  const policy = defaultPolicy();
  for (const key of Object.keys(policy)) {
    if (doc && Object.prototype.hasOwnProperty.call(doc, key)) policy[key] = doc[key];
  }
  if (doc?.updatedAt) policy.updatedAt = doc.updatedAt;
  if (doc?.updatedBy) policy.updatedBy = doc.updatedBy;
  return policy;
}

function validatePolicy(input, { partial = true } = {}) {
  const errors = [];
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return { ok: false, errors: ['policy must be an object'] };
  }

  const allowed = new Set([
    'version', 'duplicateSurvivor', 'backupRetention', 'generatedCache',
    'maintenanceAuthorization'
  ]);
  for (const key of Object.keys(input)) {
    if (!allowed.has(key)) errors.push(`unknown policy field: ${key}`);
  }

  if (input.version !== undefined && input.version !== 1) {
    errors.push('version must be 1');
  }
  for (const [field, choices] of Object.entries(POLICY_CHOICES)) {
    const value = input[field];
    if (value !== undefined && value !== null && !choices.includes(value)) {
      errors.push(`${field} must be one of: ${choices.join(', ')}`);
    }
    if (!partial && (value === undefined || value === null)) {
      errors.push(`${field} is required`);
    }
  }
  if (
    input.maintenanceAuthorization !== undefined
    && input.maintenanceAuthorization !== 'explicit_per_action'
  ) {
    errors.push('maintenanceAuthorization must be explicit_per_action');
  }

  return errors.length ? { ok: false, errors } : { ok: true };
}

function decisionsRequired(policy) {
  return DECISION_DEFINITIONS
    .filter(decision => policy?.[decision.field] == null)
    .map(decision => ({
      field: decision.field,
      question: decision.question,
      choices: [...decision.choices]
    }));
}

async function getPolicy(db) {
  const stored = await db.collection(POLICY_COLLECTION).findOne({ _id: POLICY_ID });
  return publicPolicy(stored);
}

async function savePolicy(db, input, { updatedBy = 'operator' } = {}) {
  const validation = validatePolicy(input, { partial: true });
  if (!validation.ok) return validation;

  const current = await getPolicy(db);
  const next = publicPolicy({ ...current, ...input });
  // publicPolicy carries updatedAt/updatedBy metadata from the stored doc;
  // exclude it before whitelist validation or every post-first-write update
  // fails with "unknown policy field: updatedAt/updatedBy".
  const { updatedAt: _metaAt, updatedBy: _metaBy, ...validatableNext } = next;
  const completeValidation = validatePolicy(validatableNext, { partial: true });
  if (!completeValidation.ok) return completeValidation;

  const updatedAt = new Date();
  const persisted = { ...next, updatedAt, updatedBy: String(updatedBy || 'operator').slice(0, 120) };
  delete persisted._id;
  await db.collection(POLICY_COLLECTION).updateOne(
    { _id: POLICY_ID },
    { $set: persisted },
    { upsert: true }
  );
  return {
    ok: true,
    policy: publicPolicy(persisted),
    decisions_required: decisionsRequired(persisted)
  };
}

module.exports = {
  POLICY_COLLECTION,
  POLICY_ID,
  SHARED_ROOTS,
  POLICY_CHOICES,
  defaultPolicy,
  publicPolicy,
  validatePolicy,
  decisionsRequired,
  getPolicy,
  savePolicy
};
