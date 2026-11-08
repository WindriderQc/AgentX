/* Transport only. The native PTY owns the prompt, tools, transcript and turn. */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.AgentXHermesVoiceBridge = api;
})(typeof window === 'undefined' ? globalThis : window, function () {
  'use strict';
  const lost = () => new Error('Connexion interrompue. Vérifie la réponse dans le chat avant de renvoyer.');
  class Bridge {
    constructor(chat, { sdk, WebSocketImpl = WebSocket, changed = () => {} }) {
      this.chat = chat; this.sdk = sdk; this.Socket = WebSocketImpl; this.changed = changed;
      this.connected = false; this.busy = false; this.pending = null; this.closed = false;
    }
    async connect() {
      const url = await this.sdk.buildWsUrl('/api/events', { channel: this.chat.channel });
      if (this.closed) throw lost();
      const socket = this.socket = new this.Socket(url);
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => { socket.close(); reject(lost()); }, 8000);
        socket.onopen = () => { clearTimeout(timer); this.connected = true; this.changed(); resolve(); };
        socket.onerror = () => { clearTimeout(timer); reject(lost()); };
        socket.onclose = () => {
          clearTimeout(timer); this.connected = false; this.fail(lost()); this.changed(); reject(lost());
        };
        socket.onmessage = event => {
          for (const line of String(event.data).split('\n').filter(Boolean)) {
            try { const frame = JSON.parse(line); if (frame.method === "event" && frame.params) this.event(frame.params); } catch (error) { this.fail(error); }
          }
        };
      });
    }
    event(event) {
      const type = event.type, payload = event.payload || {}, sid = event.session_id;
      if (type === 'message.start') { this.busy = true; if (this.pending && !this.pending.sid) { this.pending.sid = sid; clearTimeout(this.pending.timer); } this.changed(); }
      const p = this.pending;
      if (p && (!p.sid || p.sid === sid)) {
        if (type === 'message.delta' && typeof payload.text === 'string') {
          // Reasoning/tool events never become speech.
          if (!payload.reasoning && payload.kind !== 'reasoning') { p.text += payload.text; p.delta?.(payload.text); }
        }
        if (type === 'message.complete') {
          if (payload.status && payload.status !== 'complete') this.fail(new Error('Le tour a été interrompu. Le résultat reste dans le chat.'));
          else { this.pending = null; p.clean(); p.resolve({ text: typeof payload.text === 'string' ? payload.text : p.text }); }
        }
        if (type === 'error') this.fail(new Error(payload.message || 'Le chat a signalé une erreur.'));
      }
      if (type === 'message.complete') { this.busy = false; this.changed(); }
    }
    turn(text, signal, delta) {
      if (!this.connected || this.closed) return Promise.reject(lost());
      if (this.pending || this.busy) return Promise.reject(new Error('Attends la fin de la réponse du chat avant de parler.'));
      signal.throwIfAborted();
      return new Promise((resolve, reject) => {
        const abort = () => this.fail(new DOMException('Voix arrêtée', 'AbortError'));
        let timer;
        const clean = () => { clearTimeout(timer); signal.removeEventListener('abort', abort); };
        timer = setTimeout(() => this.fail(lost()), 10000);
        this.pending = { resolve, reject, clean, delta, timer, text: '', sid: null };
        signal.addEventListener('abort', abort, { once: true });
        try { Promise.resolve(this.chat.submitText(text, signal)).catch(error => this.fail(error)); }
        catch (error) { this.fail(error); }
      });
    }
    fail(error) { const p = this.pending; this.pending = null; if (p) { p.clean(); p.reject(error); } }
    close() { this.closed = true; this.connected = false; this.fail(lost()); this.socket?.close(); }
  }
  return { Bridge };
});
