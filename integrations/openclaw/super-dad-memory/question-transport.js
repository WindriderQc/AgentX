import path from 'node:path';
const CAPABILITY = 'question-conditional-resolve-v1';
const unavailable = () => Object.assign(new Error('Native conditional questions are unavailable.'), { code: 'NATIVE_QUESTIONS_UNAVAILABLE' });

// Only the official host wrapper supplies signing and identity access. No CLI,
// HTTP, shared bearer, default identity directory or token-cache fallback.
export function createQuestionTransport({ config, loadSdk = () => import('openclaw/plugin-sdk/gateway-runtime') }) {
  const configured = () => typeof config.questionDeviceStateDir === 'string' && path.isAbsolute(config.questionDeviceStateDir)
    && typeof config.questionDeviceToken === 'string' && config.questionDeviceToken.length >= 32
    && typeof config.questionGatewayUrl === 'string';
  async function withClient(operation, { signal } = {}) {
    signal?.throwIfAborted();
    if (!configured()) throw unavailable();
    let url;
    try { url = new URL(config.questionGatewayUrl); } catch { throw unavailable(); }
    if (!['ws:', 'wss:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw unavailable();
    const { GatewayClient } = await loadSdk();
    if (typeof GatewayClient !== 'function' || typeof GatewayClient.prototype.stopAndWait !== 'function') throw unavailable();
    let client, timer, abort;
    try {
      const ready = new Promise((resolve, reject) => {
        abort = () => { client?.stop(); reject(unavailable()); };
        signal?.addEventListener('abort', abort, { once: true });
        timer = setTimeout(() => reject(unavailable()), 8000);
        client = new GatewayClient({ url: url.href, clientName: 'gateway-client', mode: 'backend',
          role: 'operator', scopes: ['operator.questions'], sharedStateMode: 'read-only',
          // This explicitly selected private client root has an existing native
          // credentials.sqlite. The SDK may read it, never create an identity.
          env: { OPENCLAW_STATE_DIR: config.questionDeviceStateDir },
          deviceToken: config.questionDeviceToken,
          preparedDeviceAuth: { token: config.questionDeviceToken, role: 'operator', scopes: ['operator.questions'], updatedAtMs: 0 },
          onHelloOk: hello => {
            if (hello.auth?.method !== 'device-token' || hello.auth.role !== 'operator'
                || hello.auth.scopes?.length !== 1 || hello.auth.scopes[0] !== 'operator.questions'
                || !hello.features?.capabilities?.includes(CAPABILITY)
                || !['question.list', 'question.resolve', 'question.waitAnswer'].every(m => hello.features.methods.includes(m))) {
              reject(unavailable()); return;
            }
            resolve();
          },
          onConnectError: () => reject(unavailable()),
          onClose: () => reject(unavailable()) });
        client.start();
      });
      await ready;
      clearTimeout(timer);
      return await operation((method, params) => { signal?.throwIfAborted(); return client.request(method, params, { timeoutMs: 5000 }); });
    } finally {
      clearTimeout(timer);
      if (abort) signal?.removeEventListener('abort', abort);
      await client?.stopAndWait();
    }
  }
  return { configured, withClient };
}
