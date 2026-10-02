'use strict';

// The Household secretary API (/api/secretary): personal tasks, the daily
// briefing and desk, mail routes and email-action readiness.

const deviceAcceptance = require('./device-acceptance');
const { cachedProjectedJson } = require('./panel-sources');
const { dadBriefing, dadDesk } = require('./briefing');
const { householdActivation } = require('./readiness');
const { registerSecretaryMailRoutes } = require('./secretary-mail-routes');
const { checkEmailActionReadiness } = require('./email-action');

function registerSecretaryRoutes(app, {
  express, standardJsonParser, envelope, personalTasks, fail, CORE_SELF_URL,
  bridgeProjection, secretaryMail, familyTasks, models, knowledgeState, mongoose
}) {
  const secretary = express.Router();
  secretary.use(standardJsonParser);
  secretary.get('/tasks', async (req, res) => {
    try {
      return envelope(res, await personalTasks.list(req.query));
    } catch (error) {
      return fail(res, error.status || 500, error.message, error.code || 'SECRETARY_LIST_FAILED', error.details);
    }
  });
  secretary.get('/briefing', async (_req, res) => {
    try {
      const [report, tasks] = await Promise.all([
        cachedProjectedJson(
          `${CORE_SELF_URL()}/api/reports/morning-brief`,
          (body) => body,
          { unavailable: true },
          8000
        ),
        personalTasks.list({ limit: 100 }).then(result => result.tasks)
      ]);
      return envelope(res, dadBriefing(report, tasks));
    } catch (error) {
      return fail(res, 500, error.message, 'SECRETARY_BRIEFING_FAILED');
    }
  });
  secretary.get('/desk', async (_req, res) => {
    try {
      const [report, tasks, cron, mailBacklog, family, latestDevice, budget] = await Promise.all([
        cachedProjectedJson(
          `${CORE_SELF_URL()}/api/reports/morning-brief`,
          (body) => body,
          { unavailable: true },
          8000
        ),
        personalTasks.list({ limit: 100 }).then(result => result.tasks),
        bridgeProjection(
          'getOpenClawCronProjection',
          (body) => body,
          { unavailable: true },
          { includeDisabled: true }
        ),
        // The count is cached by its owner. Neither a Gmail failure nor a slow
        // host delays the desk: a late count simply shows on the next refresh.
        Promise.race([
          secretaryMail().backlog(),
          new Promise((resolve) => { setTimeout(resolve, 6000, { error: 'The unlabelled count is still being read.' }).unref?.(); })
        ]).catch((error) => ({ error: error.message })),
        Promise.all([
          familyTasks.listProfiles().then(result => result.profiles),
          familyTasks.list().then(result => result.chores)
        ]).then(([profiles, chores]) => ({ profiles, chores })),
        models.DeviceAcceptance.findOne({ phase: deviceAcceptance.PHASE }).sort({ completedAt: -1 }).lean(),
        cachedProjectedJson(
          `${CORE_SELF_URL()}/api/budget/status`,
          (body) => body?.data || body,
          { unavailable: true },
          8000
        )
      ]);
      const activation = householdActivation({
        family,
        cron,
        knowledge: knowledgeState.status,
        device: deviceAcceptance.contract(latestDevice)
      });
      return envelope(res, {
        ...dadDesk(report, tasks, cron, new Date(), family, activation, budget, mailBacklog),
        activation
      });
    } catch (error) {
      return fail(res, 500, error.message, 'SECRETARY_DESK_FAILED');
    }
  });
  // Dad's two actionable Gmail labels and the owner's sender triage rules.
  registerSecretaryMailRoutes({ app, router: secretary, mongoose, envelope, fail });
  secretary.get('/email-action/readiness', async (_req, res) => {
    const readiness = await checkEmailActionReadiness();
    if (readiness.code === 'EMAIL_ACTION_READY') return envelope(res, { readiness });
    return fail(res, 503, 'Email-action readiness is unavailable', readiness.code, { readiness });
  });
  secretary.post('/tasks', async (req, res) => {
    try {
      const task = await personalTasks.create(req.body || {});
      return envelope(res, { task }, 201);
    } catch (error) {
      return fail(res, error.status || 500, error.message, error.code || 'SECRETARY_CREATE_FAILED', error.details);
    }
  });
  secretary.post('/tasks/update', async (req, res) => {
    try {
      const task = await personalTasks.update(req.body || {});
      return envelope(res, { task });
    } catch (error) {
      return fail(res, error.status || 500, error.message, error.code || 'SECRETARY_UPDATE_FAILED', error.details);
    }
  });
  secretary.post('/tasks/complete', async (req, res) => {
    try {
      return envelope(res, await personalTasks.complete(req.body || {}));
    } catch (error) {
      return fail(res, error.status || 500, error.message, error.code || 'SECRETARY_COMPLETE_FAILED', error.details);
    }
  });
  app.use('/api/secretary', secretary);
}

module.exports = { registerSecretaryRoutes };
