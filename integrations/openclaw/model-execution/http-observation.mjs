import { AsyncLocalStorage } from 'node:async_hooks';
import { channel } from 'node:diagnostics_channel';

// Observe the native transport without replacing fetch, authentication,
// retries or routing. Undici shares the same request object across events;
// this also separates concurrent calls reusing a provider connection.
const active = new AsyncLocalStorage(), owners = new WeakMap();
export const refusalStatuses = new Set([400, 401, 402, 403, 404, 422, 429]);
channel('undici:request:create').subscribe(({ request }) => {
  try {
    const owner = active.getStore();
    if (!owner || request.method !== 'POST') return;
    const url = new URL(request.path, request.origin);
    if (url.origin !== owner.origin || url.pathname !== owner.path || url.search) return;
    owner.attempts++;
    owners.set(request, owner);
  } catch { /* Observation failure never changes the native transport. */ }
});
channel('undici:request:headers').subscribe(({ request, response }) => {
  try {
    const owner = owners.get(request);
    if (!owner) return;
    owner.responses.push({ status: response.statusCode, at: new Date().toISOString() });
  } catch { /* Missing evidence keeps the caller's UNKNOWN fence. */ }
});
export function observationFor(model) {
  try {
    const url = new URL(model.baseUrl.endsWith('/') ? model.baseUrl : model.baseUrl + '/');
    const suffix = { 'openai-completions': 'chat/completions', 'openai-responses': 'responses', 'anthropic-messages': 'v1/messages' }[model.api];
    if (!suffix) return null;
    return { origin: url.origin, path: url.pathname + suffix, attempts: 0, responses: [] };
  } catch { return null; }
}
export function observeHttp(observation, run) {
  const stream = active.run(observation, run);
  return { [Symbol.asyncIterator]() {
    const iterator = stream[Symbol.asyncIterator]();
    return { next: (...args) => active.run(observation, () => iterator.next(...args)),
      ...(iterator.return ? { return: (...args) => active.run(observation, () => iterator.return(...args)) } : {}) };
  } };
}
export function refusedResponse(observation) {
  if (observation?.attempts !== 1 || observation.responses.length !== 1) return null;
  const response = observation.responses[0];
  return refusalStatuses.has(response.status) ? response : null;
}
// A small machine projection, never upstream messages, bodies or reasoning.
export function errorMetadata(value) {
  const safe = text => typeof text === 'string' && /^[A-Za-z0-9_.-]{1,80}$/.test(text) ? text : null;
  let body;
  try { body = JSON.parse(value?.errorBody || 'null'); } catch { /* no machine body */ }
  const param = body?.error?.param ?? body?.param;
  const parameters = ['temperature', 'top_p', 'reasoning', 'reasoning_effort', 'max_output_tokens', 'max_tokens', 'store', 'include', 'tool_stream', 'model'];
  const message = typeof value?.errorMessage === 'string' ? value.errorMessage : '';
  return { code: safe(value?.errorCode), type: safe(value?.errorType), parameter: parameters.includes(param) ? param : null,
    category: /\b(?:credits?|balance|quota|billing)\b/i.test(message) ? 'billing' : /\b(?:unsupported|invalid|parameter|argument)\b/i.test(message) ? 'request' : null };
}
