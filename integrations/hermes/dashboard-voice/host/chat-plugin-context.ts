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
    submitText(text: string) {
      if (!text.trim() || text.length > 12000 || /[\x00-\x08\x0b-\x1f\x7f-\x9f]/.test(text)) {
        throw new Error("The transcript is empty, too long, or contains terminal controls.");
      }
      // The native composer receives a paste and its normal Enter, once.
      socket().send(`\x1b[200~${text}\x1b[201~\r`);
    },
    interrupt() { socket().send("\x03"); },
  };
}
