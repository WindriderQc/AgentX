/** A slot may address only the PTY generation that supplied its context. */
interface ChatPluginOptions {
  channel: string;
  profile: string;
  scope: string;
  active: boolean;
  ready: boolean;
  getSocket: () => WebSocket | null;
  getScope: () => string;
}
export function createChatPluginContext(options: ChatPluginOptions) {
  const socket = () => {
    const ws = options.getSocket();
    if (!options.active || !options.ready || options.scope !== options.getScope() || ws?.readyState !== 1) {
      throw new Error("The chat changed or disconnected. Start voice again in the current chat.");
    }
    return ws;
  };
  return {
    channel: options.channel, profile: options.profile, scope: options.scope,
    ready: options.active && options.ready,
    submitText(text: string, signal?: AbortSignal) {
      if (!text.trim() || text.length > 12000 || /[\x00-\x08\x0b-\x1f\x7f-\x9f]/.test(text)) {
        throw new Error("The transcript is empty, too long, or contains terminal controls.");
      }
      signal?.throwIfAborted();
      const ws = socket();
      // A coalesced paste + Enter is one paste event in the native TUI: its
      // trailing newline is stripped. Wait for its output before a separate
      // Enter. A missing acknowledgement leaves a draft, never a replay.
      return new Promise<void>((resolve, reject) => {
        const clean = () => {
          clearTimeout(timer);
          ws.removeEventListener("message", output);
          ws.removeEventListener("close", closed);
          signal?.removeEventListener("abort", aborted);
        };
        const fail = (error: unknown) => { clean(); reject(error); };
        const closed = () => fail(new Error("The terminal disconnected. Check the draft before sending again."));
        const aborted = () => fail(new DOMException("Submission cancelled", "AbortError"));
        const output = (event: MessageEvent) => {
          if (!event.data || (event.data instanceof ArrayBuffer && !event.data.byteLength)) return;
          if (typeof event.data === "string") {
            try { if (JSON.parse(event.data)?.type) return; } catch { /* PTY bytes */ }
          }
          // Only one output can release Enter, after the PTY frame handlers.
          ws.removeEventListener("message", output);
          queueMicrotask(() => {
            try {
              signal?.throwIfAborted();
              if (socket() !== ws) throw new Error("The terminal changed. Check the draft before sending again.");
              ws.send("\r"); clean(); resolve();
            } catch (error) { fail(error); }
          });
        };
        const timer = setTimeout(() => fail(new Error("The terminal did not acknowledge pasted text. Check the draft before sending again.")), 3000);
        ws.addEventListener("message", output);
        ws.addEventListener("close", closed);
        signal?.addEventListener("abort", aborted, { once: true });
        try { ws.send(`\x1b[200~${text}\x1b[201~`); } catch (error) { fail(error); }
      });
    },
    interrupt() { socket().send("\x03"); },
  };
}
