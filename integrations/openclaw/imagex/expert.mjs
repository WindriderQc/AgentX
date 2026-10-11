import { spawn } from 'node:child_process';
import path from 'node:path';
import textPolicy from '../../../core/public/js/image-text-policy.js';

export function runExpert(command, input, { spawnImpl = spawn, timeoutMs = 180000 } = {}) {
  if (!path.isAbsolute(command || '')) throw new Error('Configure an absolute image expert executable');
  const prompt = input.action === 'plan' ? input.request?.prompt : input.prompt;
  if (typeof prompt !== 'string' || !prompt.trim() || prompt.length > 8000) throw new Error('Image brief must contain 1–8000 characters');
  if (!['plan', 'consult'].includes(input.action)) throw new Error('Unknown image expert action');
  return new Promise((resolve, reject) => {
    const chunks = [];
    let bytes = 0, settled = false;
    const child = spawnImpl(command, [], { stdio: ['pipe', 'pipe', 'pipe'], shell: false });
    const finish = (error, value) => {
      if (settled) return;
      settled = true; clearTimeout(timer);
      if (error) reject(error); else resolve(value);
    };
    const timer = setTimeout(() => {
      child.kill('SIGTERM'); finish(new Error('Image expert timed out; no image was submitted'));
    }, timeoutMs);
    child.on('error', () => finish(new Error('Image expert could not start')));
    child.stdin.on('error', () => {});
    child.stderr.on('data', () => {});
    child.stdout.on('data', data => {
      bytes += data.length;
      if (bytes > 262144) {
        child.kill('SIGTERM'); finish(new Error('Image expert response exceeded its limit'));
      } else chunks.push(Buffer.from(data));
    });
    child.on('close', code => {
      if (settled) return;
      try {
        const value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        if (code !== 0 || value.ok !== true || value.expert !== 'hermes' || typeof value.text !== 'string' || !value.text.trim()) {
          throw new Error('Image expert failed; no image was submitted');
        }
        finish(null, value);
      } catch { finish(new Error('Image expert returned no valid result; no image was submitted')); }
    });
    child.stdin.end(JSON.stringify(input));
  });
}

export function prepareImage(original, status, expert) {
  const text = expert.text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  let plan;
  try { plan = JSON.parse(text); } catch { throw new Error('Image expert returned an invalid plan'); }
  if (!plan || Array.isArray(plan) || Object.keys(plan).some(key => !['prompt', 'profile', 'width', 'height', 'reason', 'textPlan'].includes(key))) {
    throw new Error('Image expert returned unsupported parameters');
  }
  const profile = status.profiles?.find(item => item.id === plan.profile);
  if (!profile || status.configured !== true) throw new Error('Image expert selected an unavailable profile');
  if (typeof plan.prompt !== 'string' || !plan.prompt.trim() || plan.prompt.length > 8000) throw new Error('Image expert returned an invalid prompt');
  if (![plan.width, plan.height].every(n => Number.isInteger(n) && n >= 256 && n <= 2752 && n % 32 === 0)
    || plan.width * plan.height > profile.maxPixels) throw new Error('Image expert exceeded the configured image budget');
  for (const key of ['profile', 'width', 'height']) {
    if (original[key] !== undefined && original[key] !== plan[key]) throw new Error(`Image expert changed the requested ${key}`);
  }
  if (plan.reason !== undefined && (typeof plan.reason !== 'string' || plan.reason.length > 2000)) throw new Error('Invalid image expert explanation');
  const policy = textPolicy.validate(original.textPolicy);
  const labelPlan = textPolicy.validatePlan(plan.textPlan, policy, original.constraints);
  const resolvedPolicy = textPolicy.applyPlan(labelPlan, policy, original.constraints);
  if (policy || original.constraints) textPolicy.compose(plan.prompt, original.constraints, resolvedPolicy);
  if (labelPlan) plan.textPlan = labelPlan;
  return { request: { prompt: plan.prompt.trim(), profile: plan.profile, width: plan.width, height: plan.height,
    ...(resolvedPolicy && { textPolicy: resolvedPolicy }), ...(original.constraints && { constraints: original.constraints }) },
    expert: { ...expert, plan } };
}
