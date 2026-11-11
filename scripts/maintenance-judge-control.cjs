'use strict';

const fs = require('node:fs');

async function judgeControl(config, options, { run, composeArgs, launcherEnv, ActionError }) {
  if (Object.keys(options).some(key => !['actor', 'operation', 'file'].includes(key))
    || !['cancel', 'settle'].includes(options.operation) || !options.file)
    throw new ActionError('Use --operation cancel|settle --file <prepared cancellation> --actor <owner>', { exitCode: 2 });
  const bytes = fs.readFileSync(options.file);
  if (bytes.length > 16384) throw new ActionError('Prepared cancellation exceeds its bound', { exitCode: 2 });
  const prepared = JSON.parse(bytes.toString('utf8'));
  const body = prepared.http?.body, scope = prepared.scope;
  if (prepared.contract !== 'agentx.prepared-judge-cancellation/v1' || !scope?.admissionId
    || body?.workloadId !== scope.workloadId || prepared.execution?.noRestart !== true)
    throw new ActionError('An exact prepared cancellation with noRestart is required', { exitCode: 2 });
  const input = { id: scope.admissionId, workloadId: body.workloadId, requestId: body.requestId, reason: body.reason };
  const revision = run('git', ['rev-parse', 'HEAD']).output.trim();
  if (run('git', ['merge-base', '--is-ancestor', 'HEAD', 'origin/main'], { allowFailure: true }).status !== 0
    || run('git', ['status', '--porcelain']).output.trim())
    throw new ActionError('Control requires a clean reviewed checkout on origin/main', { exitCode: 4, outcome: 'refused' });
  const env = launcherEnv(config, revision), compose = composeArgs(config);
  // Building/creating this disposable command container never replaces the
  // running Core, Benchmark, Ollama or their native ownership.
  run('docker', [...compose, 'build', 'core'], { env });
  const executed = run('docker', [...compose, 'run', '--rm', '--no-deps', '-T', '--entrypoint', 'node', 'core',
    'scripts/judge-calibration-operator.cjs', '--operation', options.operation, '--actor', options.actor,
    '--input', Buffer.from(JSON.stringify(input)).toString('base64')], { env, allowFailure: true });
  const uncertain = () => new ActionError('Native control response is unverified; reconcile the original request',
    { outcome: 'unknown', exitCode: 3, details: { revision, admissionId: input.id, requestId: input.requestId,
      tail: executed.output.slice(-1000) } });
  if (executed.status !== 0) throw uncertain();
  const line = executed.output.split('\n').findLast(value => value.startsWith('{'));
  let result;
  try { result = JSON.parse(line || 'null'); } catch { throw uncertain(); }
  if (result?.schema !== 'agentx.judge-calibration-operator/v1' || result.operation !== options.operation
    || result.result?.calibration?.admissionId !== scope.admissionId)
    throw uncertain();
  return { revision, noRestart: true, ...result };
}

module.exports = { judgeControl };
