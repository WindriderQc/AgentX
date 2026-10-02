/* Shared Open loading/release lifecycle for the text and voice surfaces. */
(function (root) {
  'use strict';
  class OpenHold {
    constructor(changed = () => {}, transport = root.fetch.bind(root)) {
      this.changed = changed; this.fetch = transport;
      // This identifies a tab's intent, not a credential. Raw LAN HTTP pages
      // still work when the secure-context randomUUID API is unavailable.
      this.clientId = root.crypto?.randomUUID?.() || `tab-${Date.now()}-${Math.random().toString(36).slice(2)}`;
      this.revision = 0;
      this.active = false; this.snapshot = null; this.timer = null;
      this.renderTimer = null; this.observedAt = 0; this.elapsedMs = 0;
      this.watching = true;
    }
    async poll(method = 'GET', revision = this.revision, watch = true) {
      clearTimeout(this.timer);
      const query = new URLSearchParams({ clientId: this.clientId, revision: String(revision), active: String(this.active) });
      try {
        const response = await this.fetch(`/api/voice-personas/private/open/hold?${query}`, {
          method, keepalive: method !== 'GET', signal: method === 'GET' ? AbortSignal.timeout(10000) : undefined
        });
        const body = await response.json();
        if (!response.ok) throw new Error(body.message || 'Open status is unavailable.');
        if (revision !== this.revision) return this.snapshot;
        const snapshot = body.data.hold, now = Date.now();
        const sameLoad = this.snapshot?.phase === snapshot?.phase
          && this.snapshot?.warm?.startedAt === snapshot?.warm?.startedAt;
        const reportedMs = snapshot?.warm?.elapsedMs || 0;
        // A delayed reply must not rewind a clock that already advanced.
        this.elapsedMs = sameLoad ? Math.max(reportedMs, this.elapsedMs + now - this.observedAt) : reportedMs;
        this.snapshot = snapshot;
        this.observedAt = now;
      } catch (error) {
        if (revision !== this.revision) return this.snapshot;
        this.snapshot = { phase: 'error', warm: { error: error.message } };
      }
      this.render();
      if (watch && this.watching && revision === this.revision && (this.active || (!restored(this.snapshot) && !this.snapshot?.active && Date.now() < this.restoreUntil))) {
        this.timer = setTimeout(() => this.poll('GET', revision), 3000);
      }
      return this.snapshot;
    }
    render() {
      clearTimeout(this.renderTimer);
      this.renderTimer = null;
      let display = this.snapshot;
      if (this.active && ['loading', 'pending'].includes(display?.phase)) {
        // Advance elapsed time between status replies, including a slow poll.
        // Only the server can change the phase to ready or failed.
        display = { ...display, warm: { ...display.warm,
          elapsedMs: this.elapsedMs + Math.max(0, Date.now() - this.observedAt)
        } };
        if (this.watching) this.renderTimer = setTimeout(() => this.render(), 1000);
      }
      this.changed(display);
    }
    start() {
      this.watching = true;
      if (this.active) return this.pending || Promise.resolve(this.snapshot);
      this.active = true; this.snapshot = null; this.render();
      const pending = this.poll('POST', ++this.revision).finally(() => { if (this.pending === pending) this.pending = null; });
      this.pending = pending;
      return pending;
    }
    release({ watch = true } = {}) {
      clearTimeout(this.timer);
      clearTimeout(this.renderTimer);
      this.renderTimer = null;
      this.watching = watch;
      if (!this.active) return Promise.resolve(this.snapshot);
      this.active = false; this.restoreUntil = Date.now() + 10 * 60_000;
      // Send immediately, even if acquisition is still pending. The adapter
      // orders this client's intent and serializes the corresponding mutation.
      return this.poll('DELETE', ++this.revision, watch);
    }
  }
  function restored(hold) {
    return hold?.restoration ? hold.restoration.phase === 'ready' : hold?.pinResident === true;
  }
  function describe(hold, active = true) {
    if (!hold) return 'Checking inference-host…';
    if (hold.phase === 'blocked') return 'inference-host could not finish an earlier request. Open is unavailable until the server is recovered.';
    if (hold.phase === 'error') return active
      ? hold.warm?.error || 'Open could not load. Try again or leave Open.'
      : 'Could not confirm that Open was released. Reopen Open and leave it again to retry.';
    if (hold.phase === 'unsupported') return 'Open model status is unavailable on this Core version.';
    if (!active) {
      if (hold.active) return 'Open is still in use by another conversation.';
      if (restored(hold)) return 'The everyday model is ready on inference-host.';
      return hold.restoration?.phase === 'loading'
        ? 'Restoring the everyday model on inference-host… this usually takes two to three minutes.'
        : 'Open released. Finishing any current model work, then restoring the everyday model.';
    }
    const seconds = Math.round((hold.warm?.elapsedMs || 0) / 1000);
    if (hold.phase === 'loading') return `Loading the Open model on inference-host… ${seconds}s. Usually two to three minutes.`;
    if (hold.phase === 'pending') return `Waiting for inference-host to finish its current model work… ${seconds}s.`;
    if (hold.phase === 'resident') return 'Open model ready on inference-host.';
    return 'Open has idled out. Your next message will load it again.';
  }
  if (typeof module !== 'undefined' && module.exports) module.exports = { OpenHold, describe };
  else root.HouseholdOpen = { OpenHold, describe };
})(typeof window === 'undefined' ? globalThis : window);
