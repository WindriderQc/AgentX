import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import batchPlan from '../../../shared/benchmarkBatchPlan.cjs';

export function runQueueCommand(command, args, { execImpl = execFile } = {}) {
  if (typeof command !== 'string' || !command.startsWith('/')) throw new Error('Absolute queueCommand required; nothing launched');
  return new Promise((resolve, reject) => {
    execImpl(command, args, { timeout: 35 * 60000, maxBuffer: 8 << 20, shell: false }, (error, stdout) => {
      let result;
      try { result = JSON.parse(String(stdout)); } catch { return reject(new Error('Queue runner receipt unavailable; inspect the same queue request')); }
      const wantedId = args[args.indexOf('--id') + 1];
      if (error || result.ok !== true || result.data?.id !== wantedId || result.data?.kind !== 'benchmark') return reject(new Error(result.message || 'Queue runner did not confirm the matching outcome'));
      resolve(result.data);
    });
  });
}
export async function queueBenchmark(params, context, config, { fetchImpl = fetch, run = runQueueCommand } = {}) {
  if (!config?.agentxUrl || !config.queueCommand) throw new Error('Canonical Core and queueCommand required for Benchmark work; nothing launched');
  const prepare = params.action === 'benchmark-batch-prepare';
  if (prepare && (!context.runId || !context.toolCallId)) throw new Error('Native run and tool-call identity required to queue preparation');
  const request = batchPlan.batchRequest(params, { also: ['action', 'plan'], judgeRequired: true });
  const actor = `openclaw:${context.agentId}`;
  const call = async (suffix, body) => {
    const response = await fetchImpl(new URL('/api/cluster/schedule/work-queue' + suffix, config.agentxUrl), {
      method: body === undefined ? 'GET' : 'POST', redirect: 'error', signal: AbortSignal.timeout(15000),
      headers: { 'content-type': 'application/json', 'x-service-caller': actor },
      ...(body !== undefined && { body: JSON.stringify(body) })
    });
    const answer = await response.json();
    if (!response.ok || answer.ok !== true) throw new Error(answer.message || 'Core queue unavailable; no new launch authorized');
    return answer.data;
  };
  const identity = prepare ? [context.sessionKey, context.runId, context.toolCallId] : [params.plan];
  const key = `leadx:${prepare ? 'prepare' : 'start'}:` + createHash('sha256').update(JSON.stringify(identity)).digest('hex');
  let job = await call('', { key, title: `${prepare ? 'Prepare' : 'Benchmark'} · ${request.model}`, kind: 'benchmark',
    hosts: [...new Set([request.host, request.judgeHost])], estimatedMinutes: prepare ? 10 : 120,
    source: { type: 'nestor', ref: prepare ? context.sessionKey : `benchmark-plan:${params.plan}` },
    executor: { ...(prepare ? { prepare: true } : { plan: params.plan }), request }
  });
  try {
    if (job.state === 'requested') job = await call(`/${job.id}/reserve`, { expectedRevision: job.revision, start: new Date().toISOString() });
    if (job.state === 'reserved') job = await run(config.queueCommand, ['run', '--actor', actor, '--id', job.id, '--revision', String(job.revision)]);
    else if (['dispatching', 'running', 'uncertain'].includes(job.state)) job = await call(`/${job.id}/reconcile`, {});
  } catch (error) {
    const current = await call(`/${job.id}`);
    if ((prepare && current.state === 'completed' && current.releaseReceipt?.preparedPlan)
      || (!prepare && current.operation?.id && ['running', 'completed', 'failed', 'cancelled'].includes(current.state))) job = current;
    else return { contract: 'agentx.maintenance-action/v1', action: params.action, actor,
      outcome: ['dispatching', 'running', 'uncertain'].includes(current.state) ? 'unknown' : 'refused',
      result: { queueRequestId: job.id, queue: current }, message: error.message };
  }
  const result = { queueRequestId: job.id, queue: job };
  if (prepare && job.state === 'completed' && job.releaseReceipt?.preparedPlan) {
    result.plan = job.releaseReceipt.preparedPlan; result.started = false; result.request = request;
    result.start = { action: 'benchmark-batch-start', plan: result.plan, ...request };
  } else if (!prepare && job.operation?.id && ['running', 'completed', 'failed', 'cancelled'].includes(job.state)) {
    result.batchId = job.operation.id; result.plan = params.plan; result.started = true;
  }
  return { contract: 'agentx.maintenance-action/v1', action: params.action, actor,
    outcome: result.plan ? 'completed' : job.state === 'uncertain' ? 'unknown' : 'refused', result };
}
