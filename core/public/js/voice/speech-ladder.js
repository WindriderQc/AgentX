/* Voice fallback ladder for browser speech. A surface lists its voices in order;
   the first one whose stream is accepted speaks, and the device's own voice is
   the last rung when the surface allows it. */
(function (root) {
  'use strict';

  function createSpeechLadder({ request, deviceVoice = () => false, unavailable = 'Speech is unavailable.' }) {
    // Speech this ladder returned -> the rung that produced it.
    const rungs = new WeakMap();
    const issued = (speech, rung) => { rungs.set(speech, rung); return speech; };
    const rungOf = speech => (speech && typeof speech === 'object' ? rungs.get(speech) : undefined);
    // `after` is speech from this ladder whose accepted stream failed while it
    // played: the same text starts on the rung below it, never on that voice again.
    async function speak({ text, language, choices = [], after = null }, signal) {
      const first = after ? (rungOf(after) ?? choices.length - 1) + 1 : 0;
      for (let rung = first; rung < choices.length; rung++) {
        let response;
        try { response = await request({ text, language, choice: choices[rung] }, signal); }
        catch (error) { if (signal.aborted) throw error; break; }
        if (response.ok) return issued(response, rung);
        await response.body?.cancel?.().catch(() => {});
        // Invalid requests and access refusals are terminal, not voice outages.
        if ([400, 401, 403, 413].includes(response.status)) {
          throw Object.assign(new Error(`Speech request was refused (${response.status}). The complete answer remains on screen.`), { status: response.status });
        }
      }
      const device = !signal.aborted && first <= choices.length && deviceVoice({ text, language });
      if (device) {
        return issued({ browserSpeech: { text, language, ...(device.localOnly === true && { localOnly: true }) } }, choices.length);
      }
      throw new Error(unavailable);
    }
    return { speak, rungOf };
  }

  const api = { createSpeechLadder };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.AgentXSpeechLadder = api;
})(typeof window === 'undefined' ? globalThis : window);
