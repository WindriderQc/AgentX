'use strict';

// Dad's Open session keeps its inference-host model resident between turns. Ten idle
// minutes is the hold: turns refresh it; status reads do not. Leaving Open
// requests pin restoration. Other models receive a retryable busy response.
const HOUSEHOLD_OPEN_HOLD_IDLE_MS = 10 * 60_000;
const HOUSEHOLD_OPEN_HOLD_OWNER = 'agentx-household/personal_operator/open';
// Match Core's bounded warm-up budget. A still-loading model must never be
// interpreted as a primary failure that silently sends the turn to backup.
const HOUSEHOLD_OPEN_HOLD_WAIT_INTERVAL_MS = 3000;
const HOUSEHOLD_OPEN_HOLD_WAIT_TIMEOUT_MS = 10 * 60_000;

/**
 * Open-lane host hold over Core's `runtimeServices.hosts` contract. Core owns
 * the state, the warm-up, the reconciler skip, and the admission guard; this
 * only names the host, model, owner, idle window, and the context Dad's Open
 * turns request (`numCtx`), so the warm-up loads the model once at that
 * context instead of the turn reloading it at a different one.
 * `resolveTarget(env)` returns the inference target (host, model, context) or
 * throws when the lane is not configured.
 * An older Core without `hosts` degrades to "unsupported": turns still work,
 * they just pay the model swap on every idle gap.
 */
function createOpenLaneHold({
  runtimeServices,
  resolveTarget,
  logger,
  env = process.env,
  waitIntervalMs = HOUSEHOLD_OPEN_HOLD_WAIT_INTERVAL_MS,
  waitTimeoutMs = HOUSEHOLD_OPEN_HOLD_WAIT_TIMEOUT_MS
} = {}) {
  const hosts = runtimeServices?.hosts;
  const supported = Boolean(hosts
    && typeof hosts.acquireHold === 'function'
    && typeof hosts.touchHold === 'function'
    && typeof hosts.releaseHold === 'function'
    && typeof hosts.getHoldStatus === 'function');
  let holdId = null;
  // Browser intent is lifecycle bookkeeping, not authentication. It prevents
  // a late acquire from undoing a page close and one live tab releasing another.
  const clients = new Map();
  let browserMutation = Promise.resolve();
  const target = () => resolveTarget(env);
  const base = (primary) => ({
    supported,
    owner: HOUSEHOLD_OPEN_HOLD_OWNER,
    idleTtlMs: HOUSEHOLD_OPEN_HOLD_IDLE_MS,
    host: primary ? { url: primary.hostUrl, key: primary.hostKey, name: 'inference-host' } : null,
    model: primary?.model || null,
    numCtx: primary?.numCtx ?? null
  });
  const unsupported = (primary, reason) => ({
    ...base(primary),
    reason,
    phase: 'unsupported',
    hold: null,
    active: false,
    modelResident: false,
    residentContextLength: null,
    pinResident: null,
    running: [],
    warm: null,
    otherWorkWaits: false,
    foreignHold: null
  });
  const project = (primary, status) => {
    const hold = status?.hold && status.hold.owner === HOUSEHOLD_OPEN_HOLD_OWNER ? status.hold : null;
    holdId = hold?.holdId || null;
    return {
      ...base(primary),
      reason: null,
      phase: hold ? status.phase : 'none',
      hold,
      active: Boolean(hold),
      modelResident: status?.modelResident === true,
      residentContextLength: status?.residentContextLength ?? null,
      pinResident: status?.pinResident ?? null,
      restoration: status?.restoration || null,
      running: Array.isArray(status?.running) ? status.running : [],
      warm: status?.warm || null,
      otherWorkWaits: false,
      otherWorkBusy: Boolean(hold),
      foreignHold: status?.hold && !hold
        ? { owner: status.hold.owner, model: status.hold.model, expiresAt: status.hold.expiresAt }
        : null
    };
  };
  const notSupported = (primary) => unsupported(primary, 'Core runtime services do not expose host holds');
  return {
    supported,
    async browser(operation, query = {}) {
      const clientId = String(query.clientId || '').slice(0, 100);
      if (!clientId) return this[operation](); // already-open older pages
      const now = Date.now();
      for (const [id, client] of clients) if (now - client.seenAt > HOUSEHOLD_OPEN_HOLD_IDLE_MS) clients.delete(id);
      const revision = Number(query.revision) || 0;
      const previous = clients.get(clientId);
      if (previous && revision < previous.revision) return this.status();
      clients.set(clientId, { revision, active: operation === 'release' ? false : query.active !== 'false', seenAt: now });
      if (operation === 'status') return this.status();
      const run = async () => {
        const current = clients.get(clientId);
        if (current?.revision !== revision) return this.status();
        if (operation === 'acquire' && current.active) return this.acquire();
        const others = [...clients.values()].some(client => client.active && Date.now() - client.seenAt < 30000);
        return others ? this.status() : this.release();
      };
      const pending = browserMutation.then(run, run);
      browserMutation = pending.catch(() => {});
      return pending;
    },
    async status() {
      const primary = target();
      if (!supported) return notSupported(primary);
      return project(primary, await hosts.getHoldStatus({ hostUrl: primary.hostUrl }));
    },
    async acquire() {
      const primary = target();
      if (!supported) return notSupported(primary);
      const status = await hosts.acquireHold({
        hostUrl: primary.hostUrl,
        owner: HOUSEHOLD_OPEN_HOLD_OWNER,
        model: primary.model,
        idleTtlMs: HOUSEHOLD_OPEN_HOLD_IDLE_MS,
        note: 'Dad private Open session',
        // Same value the turn sends as options.num_ctx (see executeTarget).
        numCtx: primary.numCtx
      });
      return project(primary, status);
    },
    async touch({ warm = true, signal } = {}) {
      const primary = target();
      if (!supported) return notSupported(primary);
      signal?.throwIfAborted();
      try {
        if (holdId) {
          try {
            return project(primary, await hosts.touchHold({
              hostUrl: primary.hostUrl, holdId, owner: HOUSEHOLD_OPEN_HOLD_OWNER, warm
            }));
          } catch (error) {
            if (error?.code !== 'HOST_SESSION_HOLD_NOT_FOUND') throw error;
            holdId = null;
          }
        }
        return await this.acquire();
      } finally {
        // Disconnect can beat a slow Core acquire. Release that late result
        // unless another live browser still needs this shared Open hold.
        if (signal?.aborted && ![...clients.values()].some(client => client.active && Date.now() - client.seenAt < 30000)) {
          await this.release();
        }
      }
    },
    // Core refuses a second exclusive admission while the hold's warm-up owns
    // the host. Wait for residency; the page is already
    // telling Dad the model is loading. Only an actual terminal phase lets
    // the turn proceed. Cancellation and an exhausted budget stop the turn.
    async waitForResident(current = null, { signal, onStatus } = {}) {
      let status = current;
      let waited = false;
      const startedAt = Date.now();
      signal?.throwIfAborted();
      while (status && (status.phase === 'loading' || status.phase === 'pending')) {
        waited = true;
        onStatus?.(status);
        if (Date.now() - startedAt >= waitTimeoutMs) {
          throw Object.assign(new Error('The Open model is still loading. Try again when it is ready.'), {
            code: 'OPEN_MODEL_LOADING_TIMEOUT', statusCode: 504
          });
        }
        await require('node:timers/promises').setTimeout(Math.min(waitIntervalMs, waitTimeoutMs - (Date.now() - startedAt)), undefined, { signal });
        status = await this.status();
        signal?.throwIfAborted();
      }
      if (status?.phase === 'blocked') {
        throw Object.assign(new Error('inference-host could not finish an earlier request. Open is unavailable until the server is recovered.'), {
          code: 'OPEN_RUNTIME_RECOVERY_REQUIRED', statusCode: 503
        });
      }
      if (waited && (!status || status.phase === 'none')) {
        throw Object.assign(new Error('Open was released or idled out while loading. Select Open again before retrying your message.'), {
          code: 'OPEN_HOLD_ENDED', statusCode: 409
        });
      }
      onStatus?.(status);
      return status;
    },
    async release() {
      const primary = target();
      if (!supported) return { ...notSupported(primary), released: false };
      let id = holdId;
      if (!id) {
        const current = await hosts.getHoldStatus({ hostUrl: primary.hostUrl });
        if (current?.hold?.owner === HOUSEHOLD_OPEN_HOLD_OWNER) id = current.hold.holdId;
      }
      if (!id) return { ...project(primary, { hold: null, phase: 'none' }), released: false };
      const result = await hosts.releaseHold({ hostUrl: primary.hostUrl, holdId: id });
      holdId = null;
      logger?.info?.('Household Open hold released', { hostUrl: primary.hostUrl, released: result?.released === true });
      return { ...project(primary, { hold: null, phase: 'none' }), released: result?.released === true };
    }
  };
}

module.exports = {
  createOpenLaneHold,
  HOUSEHOLD_OPEN_HOLD_IDLE_MS,
  HOUSEHOLD_OPEN_HOLD_OWNER,
  HOUSEHOLD_OPEN_HOLD_WAIT_INTERVAL_MS,
  HOUSEHOLD_OPEN_HOLD_WAIT_TIMEOUT_MS
};
