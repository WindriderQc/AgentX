/* What the person should know when a spoken conversation runs slower than it
   should: slow recognition, a slow answer, or speech that arrives more slowly
   than it plays. Read from the page's own measurements of the last turn;
   browser timing, not an acoustic measurement. */
(function (root) {
  'use strict';
  // Recognition time reported by the speech service for one utterance.
  const STT_SLOW_MS = 3000;
  // Request sent to first reply text, for a turn that used no tool.
  const REPLY_SLOW_MS = 15000;
  // A played clause whose stream left the player waiting this long in total.
  const CHOPPY_GAP_MS = 300;
  const SEGMENTS = 4;
  const seconds = ms => String(Math.round(ms / 1000));

  class VoiceHealth {
    constructor() { this.turnId = null; this.tool = false; this.usedTool = false; this.reasons = []; this.segments = []; }
    // A tool run explains a long wait: it is work, not a slow machine.
    activity() { this.tool = true; }
    // The timeline of one turn; a turn reported twice keeps its first reading of tools.
    turn(turnId, timings = {}) {
      if (turnId !== this.turnId) { this.turnId = turnId; this.usedTool = this.tool; this.tool = false; }
      const reasons = [];
      if (timings.sttServer >= STT_SLOW_MS) reasons.push(`transcription lente (${seconds(timings.sttServer)} s)`);
      const wait = timings.firstDelta - timings.requestSent;
      if (!this.usedTool && wait >= REPLY_SLOW_MS) reasons.push(`réponse lente (${seconds(wait)} s)`);
      this.reasons = reasons;
    }
    // The player's metrics of one spoken clause.
    segment(metrics = {}) {
      this.segments = [...this.segments, Number(metrics.buffer_gap_ms) >= CHOPPY_GAP_MS].slice(-SEGMENTS);
    }
    notice() {
      const choppy = this.segments.filter(Boolean).length >= 2;
      const reasons = [...this.reasons, ...(choppy ? ['voix saccadée'] : [])];
      return reasons.length ? `Performance réduite : ${reasons.join(', ')}.` : '';
    }
  }

  const api = { VoiceHealth, STT_SLOW_MS, REPLY_SLOW_MS, CHOPPY_GAP_MS };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.AgentXVoiceHealth = api;
})(typeof window === 'undefined' ? globalThis : window);
