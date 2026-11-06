/* ArtX's per-display idle task and render receipts. No speech or conversation turn. */
(function (root) {
  'use strict';
  function create({ fetchImpl = root.fetch?.bind(root), now = () => Date.now(),
    uuid = () => root.crypto.randomUUID() } = {}) {
    const displayId = uuid();
    let current = null, previous = null, quietSince = null, wasQuiet = true, pending = false;
    let request = null, nextAttempt = 0, disposed = false;
    const post = async (path, body) => {
      const response = await fetchImpl('/api/family/ambient/' + path, { method: 'POST', credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      if (!response.ok) throw new Error('ArtX request unavailable');
      return (await response.json()).data;
    };
    function rendered(snapshot, scene) {
      if (!snapshot?.snapshotId || disposed) return;
      const taskId = scene.artxTaskId;
      const moment = scene.moment && { kind: scene.moment.kind,
        ...(scene.moment.id ? { id: scene.moment.id } : {}) };
      const changed = current && (JSON.stringify(current.moment) !== JSON.stringify(moment) || current.taskId !== taskId);
      if (changed) previous = current;
      current = { snapshotId: snapshot.snapshotId, at: new Date(now()).toISOString(), visible: true,
        ...(taskId ? { taskId } : {}), ...(moment ? { moment } : {}) };
    }
    function context({ visible = true } = {}) {
      const fresh = receipt => receipt && now() - Date.parse(receipt.at) <= 180000 ? receipt : null;
      return { displayId, current: current ? { ...current, visible: visible && current.visible } : null,
        previous: fresh(previous) };
    }
    function activity() {
      quietSince = null;
      if (!wasQuiet) return;
      wasQuiet = false;
      post('activity', { displayId }).catch(() => {});
    }
    async function tick({ snapshot, quiet, visible }) {
      if (disposed) return;
      if (!quiet || !visible) { activity(); return; }
      wasQuiet = true;
      if (quietSince === null) quietSince = now();
      if (pending || !fetchImpl || !snapshot?.snapshotId || now() - quietSince < (snapshot.artx?.idleMs || 120000)
        || now() < nextAttempt) return;
      pending = true;
      request ||= { displayId, requestId: uuid(), snapshotId: snapshot.snapshotId, observation: context() };
      try {
        const result = await post('idle', request);
        if (!disposed && result?.task) snapshot.artx.task = result.task;
        if (result?.status !== 'deferred') {
          request = null;
          nextAttempt = now() + (snapshot.artx?.cooldownMs || 900000);
        } else {
          // Core confirmed no inference was dispatched; a fresh occurrence may
          // use the next snapshot rather than keeping an expiring source forever.
          request = null;
          nextAttempt = now() + 15000;
        }
      } catch {
        // Reconcile the same task after a lost response; never start a substitute.
        nextAttempt = now() + 15000;
      } finally { pending = false; }
    }
    return { displayId, rendered, context, tick, activity, dispose() { disposed = true; activity(); } };
  }
  const api = { create };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.NestorArtx = api;
})(typeof window !== 'undefined' ? window : globalThis);
