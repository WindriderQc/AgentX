'use strict';

// Secretary Gmail routes: the two actionable labels (read through the OpenClaw
// host, which owns the Gmail authorization) and the owner's triage rules.
// Core owns the rules; the native gmail-secretary plugin reads them over
// loopback and applies a match without asking the model.

const RULE_CATEGORIES = Object.freeze(['Receipts', 'Newsletters', 'FYI', 'Review']);
const ADDRESS = /^[a-z0-9._%+'-]+@[a-z0-9.-]+\.[a-z]{2,}$/;
const DOMAIN = /^@?[a-z0-9-]+(?:\.[a-z0-9-]+)*\.[a-z]{2,}$/;
const RULE_ID = /^[a-f0-9]{24}$/;
const RULE_LIMIT = 500;

class TriageRuleError extends Error {
  constructor(message, code = 'SECRETARY_RULE_INVALID', statusCode = 400) {
    super(message);
    this.code = code;
    this.statusCode = statusCode;
  }
}

function text(value, max) {
  return String(value ?? '').trim().slice(0, max);
}

// A partial update validates only the fields it carries.
function normalizeRule(body = {}, { partial = false } = {}) {
  const rule = {};
  if (!partial || body.from !== undefined) {
    const from = text(body.from, 200).toLowerCase();
    if (!ADDRESS.test(from) && !DOMAIN.test(from)) {
      throw new TriageRuleError('from must be an address (name@domain.com) or a domain (@domain.com)');
    }
    rule.from = from.includes('@') && !from.startsWith('@') ? from : `@${from.replace(/^@/, '')}`;
  }
  if (!partial || body.category !== undefined) {
    if (!RULE_CATEGORIES.includes(body.category)) {
      throw new TriageRuleError(`category must be one of ${RULE_CATEGORIES.join(', ')}; action categories stay with the Secretary`);
    }
    rule.category = body.category;
  }
  if (!partial || body.subjectContains !== undefined) rule.subjectContains = text(body.subjectContains, 120);
  if (!partial || body.note !== undefined) rule.note = text(body.note, 200);
  if (!partial || body.enabled !== undefined) rule.enabled = body.enabled !== false;
  return rule;
}

function publicRule(doc) {
  return {
    id: String(doc._id),
    from: doc.from,
    subjectContains: doc.subjectContains || '',
    category: doc.category,
    enabled: doc.enabled !== false,
    note: doc.note || '',
    hits: Number(doc.hits || 0),
    lastHitAt: doc.lastHitAt || null,
    updatedAt: doc.updatedAt || null
  };
}

function createTriageRuleModel(mongoose) {
  const name = 'AgentXHouseholdSecretaryTriageRule';
  if (mongoose.models[name]) return mongoose.models[name];
  const schema = new mongoose.Schema({
    from: { type: String, required: true },
    subjectContains: { type: String, default: '' },
    category: { type: String, enum: RULE_CATEGORIES, required: true },
    enabled: { type: Boolean, default: true, index: true },
    note: { type: String, default: '' },
    hits: { type: Number, default: 0 },
    lastHitAt: { type: Date, default: null }
  }, { timestamps: true, strict: true });
  schema.index({ from: 1, subjectContains: 1 }, { unique: true });
  return mongoose.model(name, schema, 'household_secretary_triage_rules');
}

function secretaryMailControl(app) {
  const control = app.locals?.aioOpsSecretaryMail;
  if (control?.contractVersion === 1) return control;
  const unavailable = async () => { throw Object.assign(new Error('Secretary mail needs the native runtime bridge.'), { statusCode: 503, code: 'SECRETARY_MAIL_UNAVAILABLE' }); };
  return { threads: unavailable, handled: unavailable, backlog: unavailable, senders: unavailable };
}

function registerSecretaryMailRoutes({ app, router, mongoose, envelope, fail, Rule = createTriageRuleModel(mongoose) }) {
  const mail = () => secretaryMailControl(app);
  const failWith = (res, error, fallback) => {
    if (error?.code === 11000) return fail(res, 409, 'A rule already exists for this sender and subject.', 'SECRETARY_RULE_DUPLICATE');
    return fail(res, error.statusCode || error.status || 500, error.message, error.code || fallback);
  };
  const ruleId = (value) => {
    if (!RULE_ID.test(String(value || ''))) throw new TriageRuleError('Unknown rule', 'SECRETARY_RULE_NOT_FOUND', 404);
    return value;
  };

  router.get('/mail', async (req, res) => {
    try { return envelope(res, await mail().threads(req.query.label)); }
    catch (error) { return failWith(res, error, 'SECRETARY_MAIL_FAILED'); }
  });
  router.post('/mail/handled', async (req, res) => {
    try { return envelope(res, await mail().handled({ threadId: req.body?.threadId, label: req.body?.label })); }
    catch (error) { return failWith(res, error, 'SECRETARY_MAIL_FAILED'); }
  });

  router.get('/triage-rules', async (req, res) => {
    try {
      const filter = req.query.enabled === 'true' ? { enabled: true } : {};
      const rules = await Rule.find(filter).sort({ category: 1, from: 1 }).limit(RULE_LIMIT).lean();
      return envelope(res, { categories: RULE_CATEGORIES, rules: rules.map(publicRule) });
    } catch (error) { return failWith(res, error, 'SECRETARY_RULES_FAILED'); }
  });
  // Senders the Secretary most often leaves in Review: candidates for a rule.
  router.get('/triage-rules/suggestions', async (_req, res) => {
    try {
      const [senders, rules] = await Promise.all([mail().senders(), Rule.find({}).lean()]);
      const covered = new Set(rules.map(rule => rule.from));
      const rows = (senders.senders || []).map(row => ({ ...row,
        ruled: covered.has(row.address) || covered.has(`@${row.domain}`) }));
      return envelope(res, { ...senders, senders: rows });
    } catch (error) { return failWith(res, error, 'SECRETARY_RULE_SUGGESTIONS_FAILED'); }
  });
  router.post('/triage-rules', async (req, res) => {
    try {
      if (await Rule.countDocuments({}) >= RULE_LIMIT) throw new TriageRuleError('The rule list is full.', 'SECRETARY_RULES_FULL', 409);
      return envelope(res, { rule: publicRule(await Rule.create(normalizeRule(req.body))) }, 201);
    } catch (error) { return failWith(res, error, 'SECRETARY_RULE_CREATE_FAILED'); }
  });
  router.patch('/triage-rules/:id', async (req, res) => {
    try {
      const rule = await Rule.findByIdAndUpdate(ruleId(req.params.id), { $set: normalizeRule(req.body, { partial: true }) },
        { new: true, runValidators: true }).lean();
      if (!rule) throw new TriageRuleError('Unknown rule', 'SECRETARY_RULE_NOT_FOUND', 404);
      return envelope(res, { rule: publicRule(rule) });
    } catch (error) { return failWith(res, error, 'SECRETARY_RULE_UPDATE_FAILED'); }
  });
  router.delete('/triage-rules/:id', async (req, res) => {
    try {
      const removed = await Rule.findByIdAndDelete(ruleId(req.params.id)).lean();
      if (!removed) throw new TriageRuleError('Unknown rule', 'SECRETARY_RULE_NOT_FOUND', 404);
      return envelope(res, { deleted: true, id: String(removed._id) });
    } catch (error) { return failWith(res, error, 'SECRETARY_RULE_DELETE_FAILED'); }
  });
  router.post('/triage-rules/:id/hit', async (req, res) => {
    try {
      await Rule.updateOne({ _id: ruleId(req.params.id) }, { $inc: { hits: 1 }, $set: { lastHitAt: new Date() } }, { timestamps: false });
      return envelope(res, { recorded: true });
    } catch (error) { return failWith(res, error, 'SECRETARY_RULE_HIT_FAILED'); }
  });
  return { Rule };
}

module.exports = { RULE_CATEGORIES, TriageRuleError, createTriageRuleModel, normalizeRule, publicRule, registerSecretaryMailRoutes, secretaryMailControl };
