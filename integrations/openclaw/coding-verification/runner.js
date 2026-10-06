import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execute = promisify(execFile);
const TOOL = 'agentx_coding_verify';
export const grantRoot = value => path.resolve(value || path.join(os.homedir(), '.local/state/agentx/coding-verification-grants'));
const sessionKey = (agent, key) => String(key || '').toLowerCase().replace(new RegExp(`^agent:${agent}:`), '');

export function workerContext(context, agents = []) {
  return Boolean(context && /^[a-z0-9][a-z0-9-]{0,79}$/.test(context.agentId || '')
    && agents.includes(context.agentId) && String(context.sessionKey || '').startsWith(`agent:${context.agentId}:`));
}

export async function readGrant(context, root) {
  const file = path.join(root, `${context.agentId}.json`), info = await fs.lstat(file);
  if (!info.isFile() || info.isSymbolicLink() || (info.mode & 0o077) || info.nlink !== 1
    || (process.getuid && info.uid !== process.getuid())) throw new Error('Verification grant is not an operator-owned private file');
  const grant = JSON.parse(await fs.readFile(file, 'utf8'));
  if (grant.schema !== 'agentx.coding-verification-grant/v1' || grant.agent !== context.agentId
    || grant.sessionKey !== sessionKey(context.agentId, context.sessionKey) || Date.now() / 1000 >= grant.deadlineEpoch) {
    throw new Error('No active verification grant for this exact worker session');
  }
  return grant;
}

async function activeTask(grant, fetcher = fetch) {
  const url = new URL(`/api/pipeline/tasks/${grant.pipelineId}/worker`, grant.apiBase);
  url.searchParams.set('agent', grant.agent); url.searchParams.set('leaseId', grant.leaseId);
  const response = await fetcher(url, { signal: AbortSignal.timeout(5000), redirect: 'error' });
  if (!response.ok) throw new Error('Task authority is unavailable');
  const task = (await response.json())?.data?.task, lease = task?.automationLease;
  if (task?.pipelineId !== grant.pipelineId || task?.status !== 'in_progress' || task?.assignee !== grant.agent
    || lease?.leaseId !== grant.leaseId || lease?.attempt !== grant.attempt || new Date(lease?.expiresAt).getTime() <= Date.now()
    || JSON.stringify([...(task?.automation?.scope || [])].sort()) !== JSON.stringify([...grant.scope].sort())) {
    throw new Error('Worker task lease or scope changed');
  }
}

async function realTarget(target) {
  const missing = []; let current = target;
  for (;;) {
    try {
      if ((await fs.lstat(current)).isSymbolicLink()) throw new Error('Worker file access cannot follow a symlink');
      return path.join(await fs.realpath(current), ...missing);
    }
    catch (error) {
      if (error.code !== 'ENOENT' || path.dirname(current) === current) throw error;
      missing.unshift(path.basename(current)); current = path.dirname(current);
    }
  }
}

export async function fileToolGate(event, context, config, overrides = {}) {
  if (!config.agentIds?.includes(context?.agentId)) return;
  const block = message => ({ block: true, blockReason: message });
  if (!workerContext(context, config.agentIds)) return block('Worker session identity is missing');
  try {
    const grant = await readGrant(context, config.root || grantRoot(config.grantRoot));
    const tool = event.toolName;
    if (tool === TOOL) return;
    if (!['read', 'write', 'edit'].includes(tool)) return block('This worker grant allows only scoped file tools and verification');
    const requested = event.params?.path ?? event.params?.file_path;
    if (typeof requested !== 'string' || !requested.trim()) return block('A declared task file path is required');
    const repository = await fs.realpath(grant.repository);
    const target = path.resolve(repository, requested), resolved = await realTarget(target);
    if (resolved !== target) return block('Worker file access cannot follow a symlink');
    const relative = path.relative(repository, resolved).replaceAll(path.sep, '/');
    const permitted = tool === 'read' ? [...grant.scope, ...grant.sourceFiles, 'AGENTS.md', 'README.md', 'docs/STATUS.md', 'docs/ARCHITECTURE.md', 'docs/OPERATIONS.md'] : grant.scope;
    if (!permitted.includes(relative) && resolved !== grant.feedbackPath) return block('File is outside this task scope and authority');
    await (overrides.assertActive || activeTask)(grant);
  } catch (error) { return block(String(error.message)); }
}

export function buildTool(context, config, run = execute) {
  if (!workerContext(context, config.agentIds)) return null;
  const helper = config.helperPath;
  if (typeof helper !== 'string' || !path.isAbsolute(helper)) throw new Error('An operator-selected verification helper is required');
  return {
    name: TOOL, label: 'Verify assigned coding task',
    description: 'Run the assigned operator verification profile in its read-only sandbox. No command or path arguments. Final dispatcher verification remains required.',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    async execute(_callId, params) {
      if (!params || Object.keys(params).length) throw new Error('Verification accepts no command or path arguments');
      const root = grantRoot(config.grantRoot);
      await readGrant(context, root);
      let result;
      try {
        result = await run('/usr/bin/python3', [helper, 'run', '--agent', context.agentId,
          '--session-key', context.sessionKey, '--grant-root', root], {
          shell: false, timeout: 920000, maxBuffer: 3 * 1024 * 1024, windowsHide: true
        });
      } catch (error) {
        if (error.code !== 2 || !error.stdout) throw error;
        result = error;
      }
      const receipt = JSON.parse(result.stdout);
      return { content: [{ type: 'text', text: JSON.stringify(receipt) }], details: receipt };
    }
  };
}
