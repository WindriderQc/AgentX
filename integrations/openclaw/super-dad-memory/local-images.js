import { createHash } from 'node:crypto';
import { readFile, realpath, stat, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { privateOwnerContext } from './store.js';
import { mediaRoot } from './media.js';

export function imageActionKey(context, toolCallId) {
  if (!context?.sessionKey || !context.runId || !toolCallId) throw new Error('Native session, run and tool-call identities are required');
  return createHash('sha256').update(JSON.stringify([context.sessionKey, context.sessionId || '', context.runId, toolCallId])).digest('hex');
}
export function registerLocalImages(api, { fetchImpl = fetch } = {}) {
  const nativeCalls = new Map();
  const callKey = (context, id) => `${context.sessionKey}:${id}`;
  api.on?.('before_tool_call', (event, context) => {
    const id = event.toolCallId || context.toolCallId;
    const runId = event.runId || context.runId;
    if (event.toolName !== 'local_image' || !id || !runId || !context.sessionKey) return;
    nativeCalls.set(callKey(context, id), { ...context, runId });
    if (nativeCalls.size > 1000) nativeCalls.delete(nativeCalls.keys().next().value);
  });
  api.on?.('after_tool_call', (event, context) => {
    if (event.toolName === 'local_image') nativeCalls.delete(callKey(context, event.toolCallId || context.toolCallId));
  });
  api.registerTool(context => {
    if (!privateOwnerContext(context, api.config)) return null;
    const base = api.pluginConfig?.agentxUrl;
    if (!base) return null;
    const householdId = /^agent:main:household:direct:([a-f0-9-]{36})$/.exec(context.sessionKey || '')?.[1];
    const operationBase = householdId ? `/api/voice-personas/private/sessions/${householdId}/images` : '/api/images/operations';
    const call = async (route, body) => {
      const r = await fetchImpl(new URL(route === '/status' ? '/api/images/status' : operationBase + route.replace(/^\/operations/, ''), base), {
        method: body === undefined ? 'GET' : 'POST', redirect: 'error', signal: AbortSignal.timeout(30000),
        ...(body !== undefined && { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }) });
      const result = await r.json();
      if (!r.ok || !result.ok) throw new Error(result.message || 'Local image service unavailable');
      return result;
    };
    return {
      name: 'local_image', label: 'Local Image',
      description: 'Create or edit an image locally through AgentX Core. create returns a durable operation and a studio link. Household uses a quick conversation preset by default and shows progress and the image automatically. Once accepted, end this agent turn so its LLM GPU reservation can be released; do not poll in the same turn. Explain that the image is preparing. status in a later turn returns the verified state and the image when ready. Never invent success or resubmit an uncertain request. No cloud fallback. Optional referencePaths must be existing PNG/JPEG files under the native media directory; two maximum. Preserve image 1 and image 2 order in edit prompts.',
      parameters: { type: 'object', properties: {
        action: { type: 'string', enum: ['create', 'status', 'cancel', 'profiles'] },
        prompt: { type: 'string', minLength: 1, maxLength: 8000 },
        profile: { type: 'string', maxLength: 50 },
        operationId: { type: 'string', format: 'uuid' },
        width: { type: 'integer', minimum: 256, maximum: 2752 },
        height: { type: 'integer', minimum: 256, maximum: 2752 },
        referencePaths: { type: 'array', maxItems: 2, items: { type: 'string', maxLength: 500 } }
      }, required: ['action'], additionalProperties: false },
      async execute(id, params) {
        let result, actionKey;
        if (params.action === 'profiles') result = await call('/status');
        else if (params.action === 'create') {
          const references = [];
          for (const name of params.referencePaths || []) {
            const root = await realpath(mediaRoot(process.env, api.pluginConfig?.mediaRoot));
            const file = await realpath(path.resolve(root, name));
            if (!file.startsWith(root + path.sep) || (await stat(file)).size > 2.25 * 1024 * 1024) throw new Error('Reference outside media root or too large');
            references.push((await readFile(file)).toString('base64'));
          }
          actionKey = imageActionKey({ ...context, ...nativeCalls.get(callKey(context, id)) }, id);
          result = await call('/operations', { actionKey, prompt: params.prompt,
            ...(params.profile && { profile: params.profile }), ...(params.width && { width: params.width }),
            ...(params.height && { height: params.height }), references });
        } else {
          if (!/^[a-f0-9-]{36}$/.test(params.operationId || '')) throw new Error('An exact image operation id is required');
          result = await call(`/operations/${params.operationId}${params.action === 'cancel' ? '/cancel' : ''}`,
            params.action === 'cancel' ? {} : undefined);
        }
        if (result.operation) {
          if (actionKey) result.acceptedAction = { operationId: result.operation.id, actionKey };
          result.studioPath = result.operation.studioPath || `/images?operation=${result.operation.id}`;
          if (result.operation.studioUrl) result.studioUrl = result.operation.studioUrl;
        }
        const content = [];
        if (params.action === 'status' && result.operation?.state === 'completed' && result.operation.runtimeRestored === true
          && /^[a-f0-9]{64}$/.test(result.operation.artifact?.sha256 || '')) {
          const r = await fetchImpl(new URL(result.operation.artifact.url, base), { redirect: 'error', signal: AbortSignal.timeout(30000) });
          if (!r.ok) throw new Error('Archived image unavailable');
          const bytes = Buffer.from(await r.arrayBuffer());
          if (bytes.length > 50 * 1024 * 1024 || createHash('sha256').update(bytes).digest('hex') !== result.operation.artifact.sha256) throw new Error('Image integrity check failed');
          const dir = path.join(mediaRoot(process.env, api.pluginConfig?.mediaRoot), 'local-generated');
          await mkdir(dir, { recursive: true });
          const file = path.join(dir, `${result.operation.artifact.sha256}.png`);
          await writeFile(file, bytes);
          result.mediaPath = file;
          result.deliveryHint = `Use MEDIA:${file} to present this verified archived image.`;
          content.push({ type: 'image', mimeType: result.operation.artifact.mimeType, data: bytes.toString('base64') });
        }
        content.unshift({ type: 'text', text: JSON.stringify(result) });
        return { content, details: result };
      }
    };
  }, { name: 'local_image', optional: true });
}
