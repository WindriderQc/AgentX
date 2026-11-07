'use strict';

const { isDeepStrictEqual } = require('node:util');
const attempts = require('./coverageAttempts');
const settingsStore = require('./coverageSettings');
const { post } = require('./coverageLauncher');
const { checkIdle } = require('./coverageIdle');
const { validateIntent, refused } = require('./coverageQualification');
const { coreRequest } = require('../../clients/coreHttp');
const BenchmarkBatch = require('../../../models/BenchmarkBatch');

const UUID = /^[a-f0-9-]{36}$/;
const queuePath = id => `/api/cluster/schedule/work-queue/${encodeURIComponent(id)}`;
const queuePost = (path, body) => coreRequest(path, { method: 'POST', body: JSON.stringify(body) });

async function assertDispatch(attempt, body, deps = {}) {
  if (!attempt || !UUID.test(body.queueRequestId || '') || !UUID.test(body.queueDispatchId || '')
    || attempt.queueId !== body.queueRequestId || (attempt.dispatchId && attempt.dispatchId !== body.queueDispatchId)) {
    throw Object.assign(new Error('Exact coverage dispatch required'), { statusCode: 409 });
  }
  return (deps.queuePost || queuePost)(`${queuePath(attempt.queueId)}/assert-dispatch`, { dispatchId: body.queueDispatchId });
}

async function admission(id, deps = {}) {
  const attempt = await (deps.attempts || attempts).get(id);
  if (!attempt) throw refused('Coverage intent is unavailable');
  const settings = await (deps.settings || settingsStore).getSettings();
  const idle = settings.enabled && await checkIdle(settings, deps.idleDeps || require('./coverageJob').nativeIdleDeps());
  if (!idle?.idle) throw refused(`Coverage launch waits: ${idle?.reasons?.join('; ') || 'switched off'}`);
  await (deps.validateIntent || validateIntent)(attempt.intent);
  return { requestId: id, queueId: attempt.queueId, manifest: attempt.intent.manifest, admitted: true };
}

/** Native wrapper: one durable outbound fence. A lost write/HTTP answer only
 * permits reading the original batch; this path never repeats its POST. */
async function launch(id, body, deps = {}) {
  const store = deps.attempts || attempts;
  let attempt = await store.get(id);
  await assertDispatch(attempt, body, deps);
  attempt = await store.beginPost(id, body.queueRequestId, body.queueDispatchId);
  if (!attempt) return observe(id, deps);
  try {
    const data = await (deps.post || post)('/api/benchmark/batch', {
      ...attempt.intent.body, queueRequestId: attempt.queueId, queueDispatchId: body.queueDispatchId
    });
    if (!/^[a-f0-9]{24}$/.test(data.batch_id || '')) throw new Error('Native batch returned no receipt identity');
    await store.update(id, { nativeId: data.batch_id });
  } catch (error) {
    // The batch boundary owns proven refusal publication. Any other error,
    // including a committed native/result write with a lost reply, is unknown.
    await store.update(id, { launchError: String(error.message).slice(0, 1000) });
  }
  return observe(id, deps);
}

async function observe(id, deps = {}) {
  const attempt = await (deps.attempts || attempts).get(id);
  if (!attempt) throw Object.assign(new Error('Coverage intent not found'), { statusCode: 404 });
  const base = { requestId: id, queueId: attempt.queueId, dispatchId: attempt.dispatchId,
    manifest: attempt.intent.manifest, operationId: id };
  if (attempt.launchReceipt) return { ...base, state: 'failed', terminal: true,
    launchReceipt: attempt.launchReceipt, authority: 'benchmark.coverage-refusal' };
  const find = deps.findBatches || (requestId => BenchmarkBatch.find({ coverage_request_id: requestId }).limit(2).lean());
  const batches = await find(id);
  if (batches.length !== 1) return { ...base, terminal: false, uncertain: true, reason: 'No unique original coverage batch receipt' };
  const batch = batches[0];
  if (!batch.tags?.includes(`coverage-${id}`) || batch.coverage_request_id !== id
    || (attempt.nativeId && String(batch._id) !== attempt.nativeId)) throw new Error('Foreign coverage batch receipt');
  const running = ['running', 'judging'].includes(batch.status) || batch.judge_status === 'running';
  const terminal = !running && ['completed', 'failed', 'cancelled', 'stopped'].includes(batch.status);
  // A saved error at hand-off is not proof that the native executor started.
  // A terminal original receipt can resolve the ambiguity under Core release.
  if (!terminal && attempt.launchError && !attempt.nativeId && !batch.execution_started_at) return { ...base, nativeId: String(batch._id), terminal: false,
    uncertain: true, reason: attempt.launchError };
  return { ...base, nativeId: String(batch._id), terminal, runningConfirmed: running,
    uncertain: !running && !terminal, state: batch.status === 'stopped' ? 'cancelled' : batch.status,
    authority: 'benchmark.batch' };
}

/** Wrap the existing route without changing its validation/judge/admission
 * paths. Only this exact native intent can cross its one-use batch boundary. */
function batchBoundary(handler, deps = {}) {
  return async (req, res, next) => {
    if (req.body?.requestId === undefined) return handler(req, res, next);
    const store = deps.attempts || attempts;
    const originalJson = res.json;
    let attempt;
    let ownsNative = false;
    let payload;
    try {
      attempt = await store.get(req.body.requestId);
      await assertDispatch(attempt, req.body, deps);
      const expected = { ...attempt.intent.body, queueRequestId: attempt.queueId, queueDispatchId: req.body.queueDispatchId };
      if (!isDeepStrictEqual(req.body, expected)) throw refused('Coverage request differs from the immutable intent');
      // CAS precedes all possible native effects. A restart here stays unknown.
      const begun = await store.beginNative(attempt._id, attempt.queueId, req.body.queueDispatchId);
      if (!begun) return res.status(409).json({ status: 'error', code: 'COVERAGE_ALREADY_DISPATCHED', error: 'Read the original coverage request' });
      ownsNative = true;
      await admission(attempt._id, deps);
      await assertDispatch(attempt, req.body, deps);
      res.locals.assertCoverageDispatch = async () => {
        await admission(attempt._id, deps);
        await assertDispatch(attempt, req.body, deps);
      };
      res.json = value => { payload = value; return res; };
      await handler(req, res, next);
      if (!payload) throw new Error('Native batch route returned no result');
      if (payload.status === 'error' && !res.locals.coverageMayHaveStarted) {
        throw Object.assign(refused(payload.error || payload.message || 'Native launch refused'), { code: payload.code || 'COVERAGE_LAUNCH_REFUSED' });
      }
      if (payload.status === 'success' && /^[a-f0-9]{24}$/.test(payload.data?.batch_id || '')) {
        // Publish the acknowledged admission hand-off before the HTTP reply.
        await store.update(attempt._id, { nativeId: payload.data.batch_id });
      }
    } catch (error) {
      res.json = originalJson;
      if (ownsNative && error.notStarted === true) {
        try {
          const { refusal, publishRefusal } = require('../../../../shared/queueLaunchReceipt.cjs');
          const receipt = refusal(attempt.queueId, 'benchmark', error);
          await store.update(attempt._id, { launchReceipt: receipt });
          await publishRefusal(receipt, req.body.queueDispatchId, deps.queuePost || queuePost);
          return res.status(error.statusCode || 409).json({ status: 'error', error: error.message, launchReceipt: receipt });
        } catch { /* Missing persistence/release evidence stays uncertain. */ }
      }
      return res.status(503).json({ status: 'error', code: 'COVERAGE_LAUNCH_UNKNOWN', error: 'Read the original coverage request' });
    } finally { res.json = originalJson; }
    return res.json(payload);
  };
}

module.exports = { launch, observe, batchBoundary, assertDispatch, admission };
