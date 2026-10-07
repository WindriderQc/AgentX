/* Browser audio transport. Persona and conversation state remain server-owned. */
(function (root) {
  'use strict';
  const speechLanguage = typeof module !== 'undefined' && module.exports ? require('./speech-language') : root.NestorSpeech;
  const PlaybackHold = (typeof module !== 'undefined' && module.exports ? require('./playback-hold') : root.NestorPlaybackHold)?.PlaybackHold;
  const VoiceTimeline = (typeof module !== 'undefined' && module.exports ? require('./voice-timeline') : root.AgentXVoiceTimeline)?.VoiceTimeline;
  // Capture while this script is evaluating; currentScript is null once the user opens the microphone.
  const scriptUrl = root.document?.currentScript?.src;
  const captureWorkletUrl = scriptUrl
    ? new URL('./voice-capture-worklet.js?v=1.46.0', scriptUrl).href
    : '/js/voice/voice-capture-worklet.js?v=1.46.0';

  function isStopControl(text) {
    const normalized = String(text).normalize('NFD').replace(/[\u0300-\u036f]/g, '')
      .toLowerCase().replace(/[\p{P}\p{S}]/gu, ' ').replace(/\s+/g, ' ').trim();
    const command = '(?:stop(?: talking)?|arrete(?: de parler| toi)?|tais toi|silence)';
    return new RegExp('^(?:nestor )?' + command + '(?: nestor)?(?: ' + command + '(?: nestor)?)*$').test(normalized);
  }

  function nextSpeechChunkLength(pending, first = false) {
    // Media paths stay whole for the final speech cleanup, including quoted
    // paths containing punctuation or spaces. Never stream their fragments.
    const mediaAt = pending.search(/\bMEDIA:/);
    const text = mediaAt < 0 ? pending : pending.slice(0, mediaAt);
    const minimum = first ? 1 : 35, maximum = 240;
    const abbreviation = /\b(?:M|Mme|Mlle|Mr|Mrs|Ms|Dr|Dre|Pr|Prof|St|Ste|etc|e\.g|i\.e)\.$/i;
    // A period needs following whitespace: at a token boundary it may still
    // become a decimal or a URL. Closing quotes/Markdown belong to the clause.
    const boundaries = /[.!?]+(?:[ \t]*["'»”’)*_])*(?:\s+|$)/g;
    for (const match of text.matchAll(boundaries)) {
      const punctuationEnd = match.index + match[0].search(/["'»”’)*_\s]|$/);
      if (text[match.index] === '.') {
        if (!/\s/.test(match[0]) || abbreviation.test(text.slice(0, punctuationEnd))) continue;
        if (/(?:^|\s)\p{L}\.$/u.test(text.slice(0, punctuationEnd))) continue;
        if (/(?:^|\n)[ \t]*\d{1,3}\.$/.test(text.slice(0, punctuationEnd))) continue;
      }
      const end = match.index + match[0].length;
      if (end > maximum) break;
      const clause = text.slice(0, end);
      if (['**', '__', '`'].some(marker => clause.split(marker).length % 2 === 0)) continue;
      if (end >= minimum) return end;
    }
    // Long unpunctuated prose cannot postpone speech indefinitely. Prefer a
    // word boundary and retain the tail for the next delta or final flush.
    if (text.length > maximum) {
      const end = text.lastIndexOf(' ', maximum);
      if (end > 0) return end + 1;
    }
    return 0;
  }

  // Same transcript-prefix approach as native VoiX and the KidX voice prototype.
  // Recognition stays on local STT; only addressed speech enters the agent session.
  class WakeWindow {
    constructor(now = () => Date.now()) { this.now = now; this.until = 0; }
    active() { return this.now() < this.until; }
    arm() { this.until = 0; }
    extend() { this.until = this.now() + 30000; }
    accept(text, followup = this.active()) {
      const value = text.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim();
      if (/^(?:merci nestor|dors nestor|bonne nuit nestor)[.!?]*$/.test(value)) {
        this.arm(); return { text: '', activated: false };
      }
      // Local STT can hear « Eille Nestor » as « Hey, Nesta » or similar variants.
      const prefix = /^(?:(?:eille|heille|aille|hey|hei|he|eh|ey|ay|aye|elle|et|hi)(?:\s+|\s*[,!:.–—-]+\s*)nest(?:or|er|ore|a|o|ar)s?|einestor|heynestor)\b[\s,!?.:–—-]*/i.exec(value);
      if (prefix) { this.extend(); return { text: text.trim().slice(prefix[0].length).trim(), activated: true }; }
      return { text: followup ? text.trim() : '', activated: false };
    }
  }

  // Speech-to-text invents these whole sentences from silence or noise (they are
  // subtitle credits in its training data). A transcript that is nothing but one
  // of them is treated as silence: no turn, no reply. It stays in the review.
  const TRANSCRIPT_HALLUCINATIONS = new Set(['thank you', 'thank you very much', 'thank you so much', 'thanks for watching',
    'thank you for watching', 'thanks for watching and see you next time', 'please subscribe', 'you', 'bye',
    'merci d avoir regarde', 'merci d avoir regarde cette video', 'sous titres realises par la communaute d amara org',
    'sous titrage st 501', 'sous titrage societe radio canada', 'sous titres par amara org',
    'www youtube com', 'youtube com', 'https www youtube com', 'https youtube com',
    'http www youtube com', 'http youtube com']);
  function isTranscriptHallucination(text) {
    const value = String(text || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
      .replace(/[^a-z0-9]+/g, ' ').trim();
    // A lone digit from hands-free STT is indistinguishable from a short noise
    // artifact. Require a word or an addressed phrase before starting a turn.
    return /^\d$/.test(value) || TRANSCRIPT_HALLUCINATIONS.has(value);
  }

  // Phones delay and process their own speaker output beyond what EchoGuard's
  // short acoustic window can match, so a reply heard back through the mic
  // was transcribed and treated as the user interrupting. Words that the
  // current reply has just spoken are an echo, not a new request.
  const HOLDING = Object.freeze({
    fr: ['Un instant…', 'Je regarde ça…', 'Laisse-moi réfléchir une seconde…'],
    en: ['One moment…', 'Let me check…', 'Give me a second…']
  });
  // Silence before a reply's first words after which Nestor says one holding phrase.
  const HOLDING_DELAY_MS = 3000;
  function holdingPhrase(language, index = 0) {
    const phrases = HOLDING[language === 'en' ? 'en' : 'fr'];
    return phrases[index % phrases.length];
  }

  // An accepted speech stream that will not be played is closed, not left open.
  function discardSpeech(speech) {
    try { speech?.body?.cancel?.().catch(() => {}); } catch { /* already consumed */ }
  }

  function isSpokenEcho(text, spoken) {
    const words = value => String(value || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
      .match(/[a-z0-9]+/g) || [];
    const heard = words(text), said = new Set(words(spoken));
    if (!heard.length || !said.size) return false;
    return heard.filter(word => said.has(word)).length / heard.length >= 0.7;
  }

  // One contiguous microphone window and one expiring excerpt, owned by this
  // capture only. Never persisted or used as an inference input by replay.
  class AudioHistory {
    constructor(rate, now = () => Date.now(), guardSamples = 0) {
      this.rate = rate; this.now = now; this.buffer = new Float32Array(rate * 20 + guardSamples);
      this.rejected = new Uint8Array(this.buffer.length);
      this.offset = 0; this.length = 0; this.lastTime = null; this.candidate = null;
    }
    breakCapture() { this.buffer.fill(0); this.rejected.fill(0); this.offset = 0; this.length = 0; this.lastTime = null; }
    push(samples, time = this.now(), rejectedEcho = false) {
      if (this.lastTime !== null && time - this.lastTime > Math.max(250, samples.length / this.rate * 2000)) this.breakCapture();
      const tail = samples.length > this.buffer.length ? samples.subarray(samples.length - this.buffer.length) : samples;
      const first = Math.min(tail.length, this.buffer.length - this.offset);
      this.buffer.set(tail.subarray(0, first), this.offset);
      this.buffer.set(tail.subarray(first), 0);
      this.rejected.fill(rejectedEcho ? 1 : 0, this.offset, this.offset + first);
      this.rejected.fill(rejectedEcho ? 1 : 0, 0, tail.length - first);
      this.offset = (this.offset + tail.length) % this.buffer.length;
      this.length = Math.min(this.buffer.length, this.length + tail.length);
      this.lastTime = time;
    }
    forget() {
      clearTimeout(this.expiry);
      this.candidate?.samples.fill(0); this.candidate = null;
    }
    clear() { this.breakCapture(); this.forget(); }
    last() {
      if (this.candidate && this.now() >= this.candidate.expiresAt) { this.forget(); this.onExpire?.(); }
      return this.candidate;
    }
    freeze(kind = 'microphone', onExpire = () => {}, maxSamples = this.length) {
      if (!this.length) return null;
      this.forget();
      const length = Math.min(this.length, maxSamples);
      const samples = new Float32Array(length);
      const start = (this.offset - length + this.buffer.length) % this.buffer.length;
      const first = Math.min(length, this.buffer.length - start);
      samples.set(this.buffer.subarray(start, start + first));
      samples.set(this.buffer.subarray(0, length - first), first);
      let rejectedSamples = 0;
      for (let i = 0; i < length; i++) rejectedSamples += this.rejected[(start + i) % this.buffer.length];
      const capturedAt = this.now();
      this.candidate = { id: root.crypto.randomUUID(), samples, capturedAt, expiresAt: capturedAt + 120000,
        kind, rejectedSamples, stt: kind === 'utterance' ? 'pending' : 'not-sent', text: '', attempt: {} };
      this.onExpire = onExpire;
      this.expiry = setTimeout(() => { this.forget(); onExpire(); }, 120000);
      return this.candidate;
    }
    transcription(id, status, text = '', metadata = {}) {
      const last = this.last();
      if (last?.id !== id) return;
      last.stt = status; last.text = String(text).slice(0, 5000);
      for (const key of ['model', 'language', 'turnId', 'control']) {
        if (typeof metadata[key] === 'string') last.attempt[key] = metadata[key].slice(0, 160);
      }
      for (const key of ['sttMs', 'bytes']) {
        if (typeof metadata[key] === 'number' && Number.isFinite(metadata[key]) && metadata[key] >= 0) last.attempt[key] = metadata[key];
      }
    }
  }

  // Bounded energy endpointing: retain a short lead-in, ignore brief clicks,
  // and finish after silence. This is not a wake-word or speaker recognizer.
  // A turn ends after one second of silence, so a spoken hesitation ("euh…")
  // does not cut the sentence; a barge-in over Nestor still ends quickly.
  const TURN_END_SILENCE_MS = 1000, INTERRUPTION_END_SILENCE_MS = 250;
  // Recognition starts halfway through that second, on what was said so far. If the
  // silence holds, its text is ready when the turn ends; if the person goes on, it is dropped.
  const EARLY_RECOGNITION_SILENCE_MS = 500;
  // Recognition measured warm for about a minute after it last ran, and slower after that.
  const RECOGNITION_WARM_INTERVAL_MS = 45000;
  // Match the transcription upload ceiling (32 MiB), leaving room for WAV
  // and multipart headers. Reaching it is an explicit error, never a partial turn.
  const MAX_CAPTURE_BYTES = 32 * 1024 * 1024 - 64 * 1024;
  class Endpoint {
    constructor(rate, minimumVoiceMs = 160, endSilenceMs = TURN_END_SILENCE_MS) { this.rate = rate; this.minimumVoiceMs = minimumVoiceMs; this.endSilenceMs = endSilenceMs; this.maxSamples = MAX_CAPTURE_BYTES / 2; this.reset(); }
    reset() {
      this.frames = []; this.preRoll = []; this.preSamples = 0;
      this.voiceSamples = 0; this.silenceSamples = 0; this.total = 0;
      this.onsetGap = 0;
      this.speaking = false;
      this.level = 0;
      this.earlyId = null; this.earlyTaken = false; this.events = [];
    }
    // What happened since the last call: `{ type: 'early', id, samples }` when a pause is
    // long enough to start recognition, `{ type: 'resumed', id }` when speech went on after it.
    drain() { const events = this.events; this.events = []; return events; }
    push(samples) {
      const energy = Math.sqrt(samples.reduce((sum, n) => sum + n * n, 0) / samples.length);
      this.level = energy;
      const voiced = energy >= 0.015;
      if (!this.speaking) {
        this.preRoll.push(samples); this.preSamples += samples.length;
        while (this.preSamples > this.rate * 0.35 && this.preRoll.length > 1) {
          this.preSamples -= this.preRoll.shift().length;
        }
        if (voiced) { this.voiceSamples += samples.length; this.onsetGap = 0; }
        else {
          this.onsetGap += samples.length;
          // Brief unvoiced consonants must not restart the onset detector.
          if (this.onsetGap > this.rate * 0.08) this.voiceSamples = 0;
        }
        if (this.voiceSamples < this.rate * this.minimumVoiceMs / 1000) return null;
        this.speaking = true;
        this.frames = this.preRoll; this.total = this.preSamples;
        this.preRoll = []; this.preSamples = 0;
        return null;
      }
      if (this.total + samples.length > this.maxSamples) {
        throw new Error('La prise de parole dépasse la taille acceptée. Fais une pause entre tes idées, puis réactive le micro. Aucun message partiel n’a été envoyé.');
      }
      this.frames.push(samples); this.total += samples.length;
      this.silenceSamples = voiced ? 0 : this.silenceSamples + samples.length;
      if (voiced && this.earlyId !== null) { this.events.push({ type: 'resumed', id: this.earlyId }); this.earlyId = null; }
      const join = () => {
        const joined = new Float32Array(this.total);
        let offset = 0;
        for (const frame of this.frames) { joined.set(frame, offset); offset += frame.length; }
        return joined;
      };
      if (this.silenceSamples < this.rate * this.endSilenceMs / 1000) {
        if (this.earlySilenceMs && this.earlyId === null && !voiced && this.earlySilenceMs < this.endSilenceMs
            && this.silenceSamples >= this.rate * this.earlySilenceMs / 1000) {
          this.earlyId = this.earlySeq = (this.earlySeq || 0) + 1;
          this.events.push({ type: 'early', id: this.earlyId, samples: join() });
        }
        return null;
      }
      const result = join();
      // The pause that started recognition ran to the end of the turn: that text is the turn's.
      const completedEarlyId = this.earlyId, pending = this.events, sequence = this.earlySeq;
      this.reset();
      this.completedEarlyId = completedEarlyId; this.events = pending; this.earlySeq = sequence;
      return result;
    }
  }

  // Browser AEC is the primary acoustic filter. Correlation with our own output
  // rejects delayed/scaled residual playback; it is not speaker recognition.
  class EchoGuard {
    constructor(rate) { this.step = Math.max(1, Math.round(rate / 2000)); this.limit = Math.ceil(rate / this.step * 0.35); this.history = []; }
    reset() { this.history = []; }
    downsample(samples) {
      const result = [];
      for (let i = 0; i < samples.length; i += this.step) {
        let sum = 0, count = Math.min(this.step, samples.length - i);
        for (let j = 0; j < count; j++) sum += samples[i + j];
        result.push(sum / count);
      }
      return result;
    }
    isEcho(samples, reference = new Float32Array(samples.length)) {
      const mic = this.downsample(samples), output = this.downsample(reference);
      this.history.push(...output);
      if (this.history.length > this.limit + mic.length) this.history.splice(0, this.history.length - this.limit - mic.length);
      const micPower = mic.reduce((sum, n) => sum + n * n, 0);
      if (micPower < 1e-7) return false;
      // Search the acoustic tail, including sub-frame delays. Work is bounded
      // to about 2 kHz / 350 ms and never persists raw audio.
      for (let start = this.history.length - mic.length; start >= 0; start--) {
        let dot = 0, power = 0;
        for (let i = 0; i < mic.length; i++) { const ref = this.history[start + i]; dot += mic[i] * ref; power += ref * ref; }
        if (power > 1e-6 && dot * dot / (micPower * power) > 0.64) return true;
      }
      return false;
    }
  }

  function wav(samples, rate) {
    const bytes = new ArrayBuffer(44 + samples.length * 2);
    const view = new DataView(bytes);
    const word = (offset, value) => [...value].forEach((char, i) => view.setUint8(offset + i, char.charCodeAt(0)));
    word(0, 'RIFF'); view.setUint32(4, bytes.byteLength - 8, true);
    word(8, 'WAVE'); word(12, 'fmt '); view.setUint32(16, 16, true);
    view.setUint16(20, 1, true); view.setUint16(22, 1, true);
    view.setUint32(24, rate, true); view.setUint32(28, rate * 2, true);
    view.setUint16(32, 2, true); view.setUint16(34, 16, true);
    word(36, 'data'); view.setUint32(40, samples.length * 2, true);
    samples.forEach((n, i) => view.setInt16(44 + i * 2, Math.max(-1, Math.min(1, n)) * (n < 0 ? 32768 : 32767), true));
    return new Blob([bytes], { type: 'audio/wav' });
  }

  class Conversation {
    constructor(io, changed = () => {}) {
      this.io = io; this.changed = changed; this.epoch = 0;
      this.turnPending = false; this.state = 'idle'; this.session = null; this.audio = null;
      this.activeTurn = null;
      this.wake = new WakeWindow(io.now);
      this.wakeAck = null;
    }
    show(state, detail = '') { this.state = state; this.changed(state, detail); }
    current(epoch) { return epoch === this.epoch && !this.abort.signal.aborted; }
    owns(turn) { return this.current(turn.epoch) && this.activeTurn === turn && !turn.interrupted; }
    async start(selection, { automatic = false } = {}) {
      if (this.state === 'reviewing') {
        const epoch = this.epoch;
        this.show('resuming'); this.reviewSpeech?.abort();
        await this.reviewPlayback?.catch(() => {});
        if (this.current(epoch)) { this.audio.clearReview(); this.listen(epoch); }
        return;
      }
      if (!['idle', 'paused', 'error'].includes(this.state)) return;
      const epoch = ++this.epoch;
      this.abort = new AbortController();
      this.show('starting');
      const timeout = setTimeout(() => this.fail(new Error('Microphone start timed out. Check browser permission and try again.'), epoch), 30000);
      try {
        const audio = await this.io.openAudio(this.abort.signal, error => this.fail(error, epoch), { automatic });
        if (!this.current(epoch)) { audio.close(); return; }
        this.audio = audio;
        const fresh = !this.session;
        const session = this.session || await this.io.createSession(selection, this.abort.signal);
        if (!this.current(epoch)) return;
        this.session = session; this.selection = selection;
        this.wake.arm();
        this.warmRecognition(); // the greeting leaves it time to finish before the first utterance
        if (fresh && this.io.greet) await this.greet(epoch);
        this.listen(epoch);
      } catch (error) { this.fail(error, epoch); }
      finally { clearTimeout(timeout); }
    }
    // A new session speaks once its microphone, session and voice are ready, so
    // the user knows when to talk. A failed greeting never blocks listening.
    async greet(epoch) {
      try {
        const [bytes] = await Promise.all([
          this.io.greet(this.session, this.abort.signal),
          this.io.readyToSpeak?.(this.abort.signal)
        ]);
        if (!bytes || !this.current(epoch)) return;
        this.show('speaking');
        await this.audio.play(bytes, this.abort.signal);
        await this.audio.settle?.(this.abort.signal);
      } catch { /* listening starts regardless */ }
    }
    setWakeWord(enabled) {
      if (!['idle', 'paused', 'error', 'listening'].includes(this.state)) return false;
      if (this.selection) this.selection = { ...this.selection, wakeWord: !!enabled };
      this.cancelWakeAck(); this.wake.arm(); this.captureFollowup = false;
      if (this.state === 'listening') { this.audio.quiet(); this.listen(this.epoch); }
      return true;
    }
    // Someone starts speaking: a surface that can do so wakes speech recognition now,
    // while the utterance is still being said, so it is not transcribed as the first
    // inference after a pause. Never more often than recognition itself goes cold.
    warmRecognition() {
      const now = this.io.now ? this.io.now() : Date.now();
      if (typeof this.io.warm !== 'function' || now - (this.recognitionWarmAt ?? -Infinity) < RECOGNITION_WARM_INTERVAL_MS) return;
      this.recognitionWarmAt = now;
      Promise.resolve().then(() => this.io.warm()).catch(() => {}); // best effort: never delays or fails a turn
    }
    listen(epoch) {
      if (!this.current(epoch)) return;
      this.show('listening');
      this.captureFollowup = this.wake.active();
      this.audio.listen((blob, capture) => this.exchange(blob, epoch, capture), () => {
        this.warmRecognition();
        this.cancelWakeAck();
        this.captureFollowup = this.wake.active();
        if (this.current(epoch)) this.show('hearing');
      }, { onEarly: (blob, info) => this.recognizeEarly(blob, epoch, info), onEarlyCancel: id => this.dropEarly(id) });
    }
    cancelWakeAck() {
      const ack = this.wakeAck;
      if (!ack) return;
      this.wakeAck = null;
      clearTimeout(ack.timer);
      ack.speech.abort();
    }
    acknowledgeWake(epoch) {
      const ack = { speech: new AbortController(), timer: null };
      this.wakeAck = ack;
      // Keep the microphone live. A command begun during this short gap, TTS,
      // or playback cancels the acknowledgement and takes the normal turn path.
      ack.timer = setTimeout(async () => {
        try {
          if (!this.current(epoch) || this.wakeAck !== ack || this.state !== 'listening') return;
          const response = await this.io.synthesize(this.io.wakeReply?.() || { text: "Je t'écoute.", language: 'fr' }, ack.speech.signal);
          if (!this.current(epoch) || this.wakeAck !== ack || this.state !== 'listening') return;
          this.show('speaking');
          await this.audio.play(response, ack.speech.signal);
          await this.audio.settle?.(ack.speech.signal);
          if (this.current(epoch) && this.wakeAck === ack && this.state === 'speaking') {
            this.wake.extend();
            this.listen(epoch);
          }
        } catch {
          if (this.current(epoch) && this.wakeAck === ack && this.state === 'speaking') this.listen(epoch);
        } finally {
          if (this.wakeAck === ack) this.wakeAck = null;
        }
      }, this.io.wakeAckDelayMs ?? 200);
    }
    // The background brain may add one short remark at a natural pause (#169):
    // only while listening (awake, if the wake word is on) with no turn in flight.
    // The microphone pauses for that one sentence; Pause or End stops it at once.
    async interject(reply) {
      const epoch = this.epoch;
      const idle = () => this.current(epoch) && this.state === 'listening' && !this.activeTurn && !this.turnPending
        && (!this.selection?.wakeWord || this.wake.active());
      if (!reply?.text || !this.audio || !idle()) return false;
      try {
        // The remark is one utterance: the chosen language, else its own words.
        const language = speechLanguage.turnSpeechLanguage(reply.text, reply.language, this.selection?.language);
        const bytes = await this.io.synthesize({ ...reply, language }, this.abort.signal);
        if (!idle()) return false;
        this.audio.quiet(); this.show('speaking');
        await this.audio.play(bytes, this.abort.signal);
        await this.audio.settle?.(this.abort.signal);
        if (this.current(epoch)) { if (this.selection?.wakeWord) this.wake.extend(); this.listen(epoch); }
        return true;
      } catch {
        if (this.current(epoch) && this.state === 'speaking') this.listen(epoch);
        return false;
      }
    }
    monitor(turn) {
      if (turn.monitoring || !this.audio.canInterrupt || this.selection.interruption === false || !this.io.interrupt) return;
      turn.monitoring = true;
      this.audio.listen((blob, capture) => this.exchange(blob, turn.epoch, capture), () => {
        this.warmRecognition();
        this.captureFollowup = true;
        // Standalone consumers can adopt the optional hold asset separately.
        if (this.state === 'speaking' && !this.audio.holdPlayback) { this.interrupt(turn); return; }
        if (this.owns(turn)) {
          // Energy alone is not speech. Hold ongoing/arriving audio reversibly;
          // only confirmed speech or a control can cancel the native turn.
          if (!turn.candidate) {
            let resolve;
            const promise = new Promise(done => { resolve = done; });
            turn.candidate = { promise, resolve, wasSpeaking: this.state === 'speaking' };
            if (turn.candidate.wasSpeaking) this.audio.holdPlayback?.();
          }
          this.show('hearing');
        }
      }, { interruptible: true });
    }
    releaseCandidate(turn) {
      const candidate = turn?.candidate;
      if (turn) turn.candidate = null;
      candidate?.resolve();
    }
    async awaitCandidate(turn) {
      while (turn.candidate && this.owns(turn)) await turn.candidate.promise;
    }
    resumeCandidate(turn) {
      const wasSpeaking = turn.candidate?.wasSpeaking;
      if (wasSpeaking) this.audio.resumePlayback?.();
      turn.monitoring = false;
      this.show(wasSpeaking ? 'speaking' : 'thinking'); this.monitor(turn);
      this.releaseCandidate(turn);
    }
    // `stop` marks the spoken or pressed stop control: only that cancels work a
    // surface lets continue in the background (a team member's turn).
    interrupt(turn = this.activeTurn, { stop = false } = {}) {
      if (!turn || !this.owns(turn)) return;
      turn.interrupted = true;
      turn.speech.abort(); // Stop sound now; keep the microphone and session.
      this.audio.resumePlayback?.(); // Release the held clock after cancelling its sources.
      this.io.interrupted?.();
      this.show('hearing');
      // The server acknowledges only after the old turn's audit/lock settle.
      // Do not abort its HTTP stream first: that would look like a lost page.
      turn.interruption = Promise.resolve().then(() => this.io.interrupt(this.session, turn.id, this.abort.signal, { stop }))
        .then(() => { turn.interruptionSettled = true; turn.request.abort(); if (this.activeTurn === turn) this.turnPending = false; })
        .catch(error => { this.fail(error, turn.epoch); throw error; });
      turn.interruption.catch(() => {}); // handled when the captured utterance arrives
    }
    // Recognition of a pause that may be the end of the turn (see EARLY_RECOGNITION_SILENCE_MS).
    // Only a surface that offers `transcribeEarly` takes part; its failure is never the turn's.
    recognizeEarly(blob, epoch, { id } = {}) {
      this.dropEarly();
      if (typeof this.io.transcribeEarly !== 'function' || !this.current(epoch) || !['listening', 'hearing'].includes(this.state)) return;
      const abort = new AbortController(), cancel = () => abort.abort();
      this.abort.signal.addEventListener('abort', cancel, { once: true });
      let request;
      try { request = this.io.transcribeEarly(blob, this.selection.language, abort.signal); } catch { request = null; }
      if (!request) { this.abort.signal.removeEventListener('abort', cancel); return; }
      this.early = { id, abort, result: Promise.resolve(request).then(value => ({ value }), () => null)
        .finally(() => this.abort.signal.removeEventListener('abort', cancel)) };
    }
    dropEarly(id) {
      if (!this.early || (id !== undefined && this.early.id !== id)) return;
      this.early.abort.abort(); this.early = null;
    }
    async exchange(blob, epoch, capture = {}) {
      if (!this.current(epoch) || !['listening', 'hearing'].includes(this.state)) return;
      this.cancelWakeAck();
      const wakeFollowup = this.captureFollowup;
      const previous = this.activeTurn;
      this.audio.quiet();
      this.show('transcribing');
      const turn = { epoch, id: root.crypto.randomUUID(), request: new AbortController(), speech: new AbortController(), interrupted: false };
      // The end of the person's speech has just been decided: a surface that keeps
      // voice timings gets this turn's timeline from that moment.
      if (this.io.timings && VoiceTimeline) turn.timeline = new VoiceTimeline(this.io.now);
      turn.timeline?.measure('silenceMs', capture.silenceMs); turn.timeline?.measure('audioMs', capture.audioMs);
      const lifetimeSignal = this.abort.signal;
      const excerptId = this.audio.reviewStatus?.().id;
      this.audio.recordTranscription?.(excerptId, 'pending', '', { turnId: turn.id, bytes: blob.size });
      let transcribed = false;
      const cancel = () => { turn.request.abort(); turn.speech.abort(); this.releaseCandidate(turn); };
      lifetimeSignal.addEventListener('abort', cancel, { once: true });
      try {
        // Transcription may run while the explicit interruption settles, but
        // another model turn must wait for the acknowledgement.
        // The pause that ended the turn already had its recognition started: use it.
        const early = this.early && capture.earlyId != null && this.early.id === capture.earlyId ? this.early : null;
        if (!early) this.dropEarly();
        this.early = null;
        const result = (early && (await early.result)?.value) || await this.io.transcribe(blob, this.selection.language, this.abort.signal);
        let text = typeof result === 'string' ? result : String(result?.text || '');
        const stopControl = result?.control === 'stop';
        if (!this.current(epoch)) return;
        transcribed = true; turn.timeline?.mark('sttDone'); turn.timeline?.measure('sttServer', result?.sttMs);
        this.recognitionWarmAt = this.io.now ? this.io.now() : Date.now(); // it just ran
        this.audio.recordTranscription?.(excerptId, stopControl ? 'control' : text.trim() ? 'transcribed' : 'empty', text, typeof result === 'object' && result ? result : {});
        if (isTranscriptHallucination(text)) text = '';
        if (previous?.candidate && !stopControl && isSpokenEcho(text, previous.spoken)) text = '';
        if (previous?.candidate && this.owns(previous)) {
          if (!text.trim() && !stopControl) { this.resumeCandidate(previous); return; }
          this.interrupt(previous, { stop: stopControl || isStopControl(text) });
          this.releaseCandidate(previous);
        }
        if (previous?.interruption) {
          if (!previous.interruptionSettled) this.show('waiting');
          await previous.interruption;
        }
        if (!this.current(epoch)) return;
        if (stopControl || isStopControl(text)) {
          // A confirmed stop is a local control in every listening phase,
          // before wake acknowledgement. Never start a model turn to say
          // speech has stopped. A correction/question still runs below.
          this.activeTurn = null; this.turnPending = false;
          this.listen(epoch); return;
        }
        if (this.selection.wakeWord && text.trim()) {
          const accepted = this.wake.accept(text, wakeFollowup);
          text = accepted.text;
          if (accepted.activated && !text) {
            this.activeTurn = null; this.turnPending = false;
            this.listen(epoch);
            this.acknowledgeWake(epoch);
            return;
          }
        }
        if (!text.trim()) { this.activeTurn = null; this.turnPending = false; this.listen(epoch); return; }
        await this.respond(turn, text, epoch, result?.detectedLanguage);
      } catch (error) {
        if (!turn.interrupted && this.current(epoch)) {
          if (!transcribed) this.audio.recordTranscription?.(excerptId, 'failed');
          if (!transcribed && previous?.candidate && this.owns(previous)) {
            this.resumeCandidate(previous); return;
          }
          // Before a model turn exists, an STT failure is safe to inspect with
          // capture disabled. A device failure still closes and clears audio.
          if (!transcribed && !previous && this.audio.reviewStatus?.().id) {
            this.audio.quiet();
            this.show('reviewing', 'Transcription failed. Replay the captured audio, then resume when ready.');
          } else this.fail(error, epoch);
        }
      } finally {
        // Playback can already be queued while a stream is being cancelled.
        if (turn.interrupted) { turn.speech.abort(); await turn.interruption?.catch(() => {}); }
        lifetimeSignal.removeEventListener('abort', cancel);
        this.reportTimeline(turn); // a turn that ended before any reply audio
      }
    }
    // A surface that keeps voice timings receives each voice turn's timeline once:
    // when the reply's first clause starts playing, else when the turn ends.
    reportTimeline(turn) {
      void turn.timeline?.report(values => this.io.timings(turn.session, turn.id, values), () => turn.interrupted, turn.requestEnded);
    }
    // One model turn, spoken or typed: stream the reply, speak it clause by
    // clause, play a structured recording, then listen again.
    async respond(turn, text, epoch, detectedLanguage, { attachments = [] } = {}) {
      this.activeTurn = turn;
      this.io.message('user', text, false, null, attachments);
      this.show('thinking'); this.turnPending = true;
      let pending = '', streamed = false, firstChunk = true, speechError = null, playback = Promise.resolve();
      let synthesis = Promise.resolve(), prefetchSlot = Promise.resolve();
      let spokenLanguage = speechLanguage.turnSpeechLanguage(text, detectedLanguage, this.selection.language);
      let replyLanguageChosen = !!speechLanguage.explicitSpeechLanguage(this.selection.language);
      // `notice` marks words that are not the reply (a waiting notice): the
      // timeline's first audio is the reply's own first clause.
      const speak = (text, notice = false) => {
        text = (this.io.speechText || speechLanguage.speechText)(text);
        if (!text.trim() || !this.owns(turn)) return false;
        // In automatic mode the reply's own words choose its voice once. A
        // mistaken STT language must not read a French answer in English.
        if (!notice && !replyLanguageChosen) {
          spokenLanguage = speechLanguage.replySpeechLanguage(text, spokenLanguage);
          replyLanguageChosen = speechLanguage.scoreSpeechLanguage(text).decided;
        }
        turn.spoken = ((turn.spoken || '') + ' ' + text).slice(-800);
        const language = spokenLanguage;
        const previousPlayback = playback, availableSlot = prefetchSlot;
        // A voice whose accepted stream failed while it played is left for the
        // rest of the turn: `after` asks the surface for the one that follows it.
        let preparedAfter = null;
        const synthesize = () => {
          preparedAfter = turn.voiceFailure || null;
          return this.io.synthesize({ text, language, ...(preparedAfter && { after: preparedAfter.speech }) }, turn.speech.signal);
        };
        // Serialize synthesis, at most one clause ahead of the current sound.
        // A third clause waits for the first playback to finish, bounding audio.
        const prepared = synthesis.then(() => availableSlot).then(() => {
          if (!this.owns(turn) || speechError) return;
          return synthesize();
        }).catch(error => { if (!turn.interrupted) speechError = error; });
        synthesis = prepared;
        playback = previousPlayback.then(async () => {
          await this.awaitCandidate(turn);
          if (!this.owns(turn) || speechError) return;
          this.show('preparing');
          let bytes = await prepared;
          await this.awaitCandidate(turn);
          if (!this.owns(turn) || speechError) return;
          // Prepared with the voice that has since failed: prepare it again, unheard.
          if (turn.voiceFailure && preparedAfter !== turn.voiceFailure) {
            discardSpeech(bytes); bytes = await synthesize();
            await this.awaitCandidate(turn);
            if (!this.owns(turn)) return;
          }
          this.monitor(turn);
          this.show('speaking');
          if (!notice) { turn.timeline?.mark('firstAudio'); this.reportTimeline(turn); }
          try { await this.audio.play(bytes, turn.speech.signal); }
          catch (error) {
            // An accepted stream can still fail while it plays (its engine stopped).
            // Say that one clause again with the next voice; never twice in a turn.
            if (turn.voiceFailure || turn.speech.signal.aborted || !this.owns(turn)) throw error;
            turn.voiceFailure = { speech: bytes };
            this.show('preparing');
            bytes = await synthesize();
            await this.awaitCandidate(turn);
            if (!this.owns(turn)) return;
            this.show('speaking');
            await this.audio.play(bytes, turn.speech.signal);
          }
        }).catch(error => { if (!turn.interrupted) speechError = error; });
        prefetchSlot = previousPlayback;
        return true;
      };
      // A long silent wait made people speak again and cancel the turn; say once that
      // Nestor is working when no reply text has arrived after a few seconds.
      // Its words join turn.spoken, so hearing them back is echo, not an interruption.
      // The phrase never delays the answer: it is dropped when reply text arrives
      // before it plays, and it does not hold the synthesis of the first clause.
      let holdingSpeech = null;
      const dropHolding = () => { if (holdingSpeech && !holdingSpeech.playing) holdingSpeech.abort.abort(); };
      turn.session = this.session; turn.timeline?.mark('requestSent');
      const response = this.io.turn(this.session, text, turn.request.signal, delta => {
        if (!this.owns(turn)) return;
        streamed = true; pending += delta; dropHolding(); turn.timeline?.mark('firstDelta');
        let length;
        while ((length = nextSpeechChunkLength(pending, firstChunk))) {
          if (speak(pending.slice(0, length))) firstChunk = false;
          pending = pending.slice(length);
        }
      }, { turnId: turn.id, onNotice: text => speak(text, true),
        // The surface reports that every spoken word was sent: say the last clause
        // now rather than when the turn completes (its closing work can be slow).
        onSayEnd: () => { if (this.owns(turn) && streamed) { speak(pending); pending = ''; } },
        ...(attachments.length && { attachmentIds: attachments.map(item => item.id) }) });
      const holdingDelay = this.io.holdingDelayMs === undefined ? HOLDING_DELAY_MS : this.io.holdingDelayMs;
      const holding = holdingDelay === null ? null : setTimeout(() => {
        if (streamed || !this.owns(turn) || turn.interrupted) return;
        const phrase = (this.io.speechText || speechLanguage.speechText)(holdingPhrase(spokenLanguage, this.holdingIndex = (this.holdingIndex || 0) + 1));
        const hold = holdingSpeech = { abort: new AbortController(), playing: false };
        const cancel = () => hold.abort.abort();
        turn.speech.signal.addEventListener('abort', cancel, { once: true });
        const prepared = Promise.resolve().then(() => this.io.synthesize({ text: phrase, language: spokenLanguage }, hold.abort.signal));
        prepared.catch(() => {});
        playback = playback.then(async () => {
          const bytes = await prepared;
          await this.awaitCandidate(turn);
          if (hold.abort.signal.aborted || !this.owns(turn) || speechError) return;
          hold.playing = true; turn.timeline?.mark('holdingPhrase');
          this.monitor(turn); this.show('speaking');
          turn.spoken = ((turn.spoken || '') + ' ' + phrase).slice(-800); // only a phrase that plays can be heard back
          await this.audio.play(bytes, hold.abort.signal);
          // Nestor is still thinking once the phrase ends; do not show it as speaking.
          if (!streamed && this.owns(turn) && this.turnPending && this.state === 'speaking') this.show('thinking');
        }).catch(() => {}).finally(() => turn.speech.signal.removeEventListener('abort', cancel));
      }, holdingDelay);
      holding?.unref?.();
      turn.requestEnded = response.then(() => {}, () => {}).finally(() => clearTimeout(holding));
      // Listen during inference, but confirm speech before cancelling it.
      // Playback still stops immediately when the user speaks over Nestor.
      this.monitor(turn);
      const reply = await response;
      turn.timeline?.mark('firstDelta'); // an unstreamed reply: its text arrives with the completed turn
      await this.awaitCandidate(turn);
      if (!this.owns(turn)) return;
      this.turnPending = false;
      this.io.message('assistant', reply.text, false, reply.sound);
      // An unstreamed reply names its own language; a chosen preference still wins.
      if (!streamed && reply.language && !speechLanguage.explicitSpeechLanguage(this.selection.language)) spokenLanguage = reply.language;
      dropHolding();
      speak(streamed ? pending : reply.text);
      await playback;
      if (speechError) throw speechError;
      if (!this.owns(turn)) return;
      if (reply.sound) {
        this.show('preparing');
        const bytes = await recording(reply.sound, turn.speech.signal);
        await this.awaitCandidate(turn);
        if (!this.owns(turn)) return;
        this.monitor(turn); this.show('speaking');
        await this.audio.play(bytes, turn.speech.signal, false, reply.sound.gain);
      }
      await this.audio.settle?.(turn.speech.signal);
      if (!this.owns(turn)) return;
      if (this.selection.wakeWord) this.wake.extend();
      this.activeTurn = null;
      this.listen(epoch);
    }
    // A message typed while the voice conversation waits is the same turn as a
    // spoken one: Nestor answers on screen and aloud, then listens again.
    canType() { return this.state === 'listening' && !this.activeTurn && !this.turnPending && Boolean(this.session && this.audio); }
    async typed(text, { attachments = [] } = {}) {
      const epoch = this.epoch;
      text = String(text || '').trim();
      if (!text || !this.canType() || !this.current(epoch)) return false;
      this.cancelWakeAck();
      this.audio.quiet();
      const turn = { epoch, id: root.crypto.randomUUID(), request: new AbortController(), speech: new AbortController(), interrupted: false };
      const lifetimeSignal = this.abort.signal;
      const cancel = () => { turn.request.abort(); turn.speech.abort(); this.releaseCandidate(turn); };
      lifetimeSignal.addEventListener('abort', cancel, { once: true });
      try {
        await this.respond(turn, text, epoch, null, { attachments });
        return true;
      } catch (error) {
        if (!turn.interrupted && this.current(epoch)) this.fail(error, epoch);
        return false;
      } finally {
        if (turn.interrupted) { turn.speech.abort(); await turn.interruption?.catch(() => {}); }
        lifetimeSignal.removeEventListener('abort', cancel);
      }
    }
    review(source = 'microphone') {
      if (!['listening', 'hearing', 'reviewing'].includes(this.state) || this.activeTurn || this.turnPending) return false;
      if (!this.audio?.freezeReview(source)) return false;
      this.reviewSpeech?.abort(); this.audio.quiet();
      this.show('reviewing');
      return true;
    }
    async replay() {
      if (this.state !== 'reviewing') return;
      this.reviewSpeech?.abort();
      const speech = new AbortController(); this.reviewSpeech = speech;
      try { this.reviewPlayback = this.audio.playReview(speech.signal); await this.reviewPlayback; }
      catch (error) { if (!speech.signal.aborted && this.state === 'reviewing') this.show('reviewing', error.message); }
    }
    forgetReview() { this.reviewSpeech?.abort(); this.audio?.clearReview(); }
    // Pausing, a hidden page or a failure keeps the session, so resuming continues the
    // conversation the page still shows. Only an explicit end (or a new/other conversation)
    // forgets it; a forgotten session made the next start silently open an empty one.
    stop(paused = false, detail = '', { forget = !paused } = {}) {
      if (forget) this.session = null;
      this.turnPending = false;
      this.cancelWakeAck();
      this.wake.arm();
      ++this.epoch;
      this.activeTurn?.request.abort(); this.activeTurn?.speech.abort(); this.activeTurn = null;
      this.reviewSpeech?.abort(); this.abort?.abort(); this.audio?.close(); this.audio = null;
      this.show(paused ? 'paused' : 'idle', detail);
    }
    fail(error, epoch) {
      if (!this.current(epoch)) return;
      this.stop(false, '', { forget: false });
      this.show('error', error.message || 'Voice connection failed. Start again when ready.');
    }
  }

  // Last rung of the voice ladder: the device's own speech synthesis, cancelled like PCM playback.
  function speakWithBrowser({ text, language }, signal) {
    const synth = root.speechSynthesis;
    if (!synth || signal.aborted) return Promise.resolve();
    return new Promise(resolve => {
      const utterance = new root.SpeechSynthesisUtterance(text);
      const profile = speechLanguage.PROFILES?.[language === 'en' ? 'en' : 'fr'];
      utterance.lang = profile?.locale || (language === 'en' ? 'en-CA' : 'fr-CA');
      const voice = speechLanguage.pickBrowserVoice?.(synth.getVoices(), profile);
      if (voice) utterance.voice = voice;
      const done = () => { signal.removeEventListener('abort', stop); resolve(); };
      const stop = () => { synth.cancel(); done(); };
      utterance.onend = done; utterance.onerror = done;
      signal.addEventListener('abort', stop, { once: true });
      synth.speak(utterance);
    });
  }

  async function openAudio(signal, onError = () => {}, options = {}) {
    const Context = root.AudioContext || root.webkitAudioContext;
    if (!root.isSecureContext || !Context || !root.navigator.mediaDevices?.getUserMedia) {
      throw new Error('Open AgentX over trusted HTTPS in a browser with microphone support.');
    }
    const context = new Context();
    const playbackHold = PlaybackHold ? new PlaybackHold(context) : null;
    // Replay retains twenty seconds; the submitted utterance is independent
    // and continues until the person pauses, including longer speech.
    const history = new AudioHistory(context.sampleRate, () => Date.now());
    let replayAbort;
    let stream, node, source, activePlay, activeSpeech, analyser, wave, spectrum, closed = false, captureEpoch = 0;
    const readSpeechSample = () => {
      const silent = { playing: false, amplitude: 0, brightness: 0 };
      if (closed || context.state !== 'running' || !analyser || !activeSpeech || activeSpeech.signal.aborted) return silent;
      analyser.getFloatTimeDomainData(wave);
      let energy = 0;
      for (let i = 0; i < wave.length; i++) energy += wave[i] * wave[i];
      const amplitude = Math.min(1, Math.sqrt(energy / wave.length));
      if (!Number.isFinite(amplitude) || amplitude < 0.00001) return silent;
      analyser.getFloatFrequencyData(spectrum);
      let weighted = 0, total = 0;
      for (let i = 1; i < spectrum.length; i++) {
        const weight = Number.isFinite(spectrum[i]) ? Math.pow(10, spectrum[i] / 20) : 0;
        weighted += weight * i; total += weight;
      }
      return { playing: true, amplitude, brightness: total ? Math.max(0, Math.min(1, weighted / total / (spectrum.length - 1))) : 0 };
    };
    const close = () => {
      if (closed) return;
      closed = true;
      replayAbort?.abort(); history.clear();
      context.onstatechange = null;
      signal.removeEventListener('abort', close);
      stream?.getTracks().forEach((track) => track.stop());
      if (node) { node.port.onmessage = null; node.disconnect(); }
      source?.disconnect();
      analyser?.disconnect();
      activePlay?.abort();
      context.close().catch(() => {});
    };
    signal.addEventListener('abort', close, { once: true });
    try {
      if (!options.automatic) await context.resume();
      stream = await root.navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1, ...(options.inputDeviceId ? { deviceId: { exact: options.inputDeviceId } } : {}) } });
      if (closed || signal.aborted) { stream.getTracks().forEach((track) => track.stop()); throw new Error('Microphone start cancelled.'); }
      if (options.automatic) {
        let resumeTimer;
        try {
          await Promise.race([context.resume(), new Promise((resolve, reject) => {
            resumeTimer = setTimeout(() => reject(new Error('Appuyez sur Activer Nestor pour autoriser le son sur cet appareil.')), 1500);
          })]);
        } finally { clearTimeout(resumeTimer); }
        if (closed || signal.aborted) throw new Error('Microphone start cancelled.');
      }
      stream.getAudioTracks().forEach((track) => {
        track.enabled = false;
        track.onended = () => { if (!closed) onError(new Error('Microphone disconnected. Reconnect it and press Start.')); };
      });
      await context.audioWorklet.addModule(captureWorkletUrl);
      if (closed) throw new Error('Microphone start cancelled.');
      node = new root.AudioWorkletNode(context, 'nestor-capture', { numberOfInputs: 2 });
      source = context.createMediaStreamSource(stream);
      source.connect(node); node.connect(context.destination);
      if (options.observeSpeech === true) {
        analyser = context.createAnalyser();
        analyser.fftSize = 512; analyser.smoothingTimeConstant = 0;
        wave = new Float32Array(analyser.fftSize); spectrum = new Float32Array(analyser.frequencyBinCount);
        analyser.connect(context.destination);
      }
      context.onstatechange = () => {
        if (!closed && context.state !== 'running') onError(new Error('Audio paused by the browser. Press Start to resume.'));
      };
      const endpoint = new Endpoint(context.sampleRate), echo = new EchoGuard(context.sampleRate);
      const quiet = () => {
        ++captureEpoch; endpoint.reset(); node.port.onmessage = null;
        history.breakCapture();
        node.port.postMessage({ epoch: null });
        stream.getAudioTracks().forEach((track) => { track.enabled = false; });
      };
      const settings = stream.getAudioTracks()[0]?.getSettings?.() || {};
      const settle = playSignal => new Promise(resolve => {
        const finish = () => { clearTimeout(timer); playSignal?.removeEventListener('abort', finish); resolve(); };
        const timer = setTimeout(finish, 300);
        playSignal?.addEventListener('abort', finish, { once: true });
        if (playSignal?.aborted || closed) finish();
      });
      const play = async (bytes, playSignal, isReview = false, gain = null) => {
        if (!root.VoixAudio) throw new Error('The local speech player is unavailable.');
        const abort = new AbortController(); activePlay = abort;
        const cancel = () => abort.abort();
        playSignal.addEventListener('abort', cancel, { once: true });
        signal.addEventListener('abort', cancel, { once: true });
        if (closed || playSignal.aborted) cancel();
        let output;
        if (gain !== null) {
          output = context.createGain();
          output.gain.value = Number(gain) || 1;
          output.connect(context.destination);
          if (!isReview) output.connect(node, 0, 1);
        }
        const observed = analyser && !isReview && gain === null;
        if (observed) activeSpeech = abort;
        try {
          if (bytes?.browserSpeech) return await speakWithBrowser(bytes.browserSpeech, abort.signal);
          return await new root.VoixAudio.Player(!isReview && playbackHold ? playbackHold.playerContext : context, {
            destinations: output ? [output] : isReview ? [context.destination] : [observed ? analyser : context.destination, { node, input: 1 }],
            onMetrics: options.onPlaybackMetrics,
          }).play(bytes, abort.signal, { rate: gain !== null ? 1 : options.playbackRate?.() || 1 });
        } finally {
          output?.disconnect();
          playSignal.removeEventListener('abort', cancel); signal.removeEventListener('abort', cancel);
          if (activePlay === abort) activePlay = null;
          if (activeSpeech === abort) activeSpeech = null;
        }
      };
      const freeze = (kind, maxSamples = context.sampleRate * 20) => history.freeze(kind, () => replayAbort?.abort(), maxSamples);
      return {
        close, quiet, canInterrupt: [true, 'all'].includes(stream.getAudioTracks()[0]?.getSettings?.().echoCancellation), deviceLabel: stream.getAudioTracks()[0]?.label || 'This device microphone',
        reviewStatus() {
          const last = history.last();
          return { id: last?.id, recentSeconds: Math.min(20, history.length / context.sampleRate), seconds: (last?.samples.length || 0) / context.sampleRate,
            capturedAt: last?.capturedAt, expiresAt: last?.expiresAt, stt: last?.stt, text: last?.text,
            rejectedMs: (last?.rejectedSamples || 0) / context.sampleRate * 1000, attempt: last?.attempt,
            sampleRate: context.sampleRate, echoCancellation: settings.echoCancellation,
            noiseSuppression: settings.noiseSuppression, autoGainControl: settings.autoGainControl };
        },
        freezeReview(kind) { return kind === 'last' ? !!history.last() : !!freeze('microphone'); },
        clearReview() { replayAbort?.abort(); history.clear(); },
        recordTranscription(id, status, text, metadata) { history.transcription(id, status, text, metadata); },
        async playReview(playSignal) {
          const last = history.last();
          if (!last) return;
          quiet(); replayAbort?.abort();
          const abort = new AbortController(); replayAbort = abort;
          const cancel = () => abort.abort();
          playSignal.addEventListener('abort', cancel, { once: true });
          if (playSignal.aborted) abort.abort();
          try { await play(await wav(last.samples, context.sampleRate).arrayBuffer(), abort.signal, true); await settle(abort.signal); }
          finally { playSignal.removeEventListener('abort', cancel); if (replayAbort === abort) replayAbort = null; }
        },
        listen(onUtterance, onSpeech, { interruptible = false, onEarly = null, onEarlyCancel = null } = {}) {
          if (closed) return;
          history.breakCapture();
          endpoint.reset(); echo.reset(); endpoint.minimumVoiceMs = interruptible ? 100 : 160;
          endpoint.endSilenceMs = interruptible ? INTERRUPTION_END_SILENCE_MS : TURN_END_SILENCE_MS;
          endpoint.earlySilenceMs = !interruptible && onEarly ? EARLY_RECOGNITION_SILENCE_MS : 0;
          const expected = ++captureEpoch;
          node.port.onmessage = ({ data }) => {
            if (closed || data.epoch !== expected || expected !== captureEpoch) return;
            const prior = endpoint.speaking;
            const rejectedEcho = echo.isEcho(data.samples, data.reference);
            history.push(data.samples, data.time === undefined ? Date.now() : data.time * 1000, rejectedEcho);
            let utterance;
            try { utterance = endpoint.push(rejectedEcho ? new Float32Array(data.samples.length) : data.samples); }
            catch (error) { quiet(); onError(error); return; }
            if (!prior && endpoint.speaking) onSpeech();
            for (const event of endpoint.drain()) {
              if (event.type === 'early') onEarly?.(wav(event.samples, context.sampleRate), { id: event.id });
              else onEarlyCancel?.(event.id);
            }
            if (utterance) {
              freeze('utterance', Math.min(utterance.length, context.sampleRate * 20)); quiet();
              onUtterance(wav(utterance, context.sampleRate), { audioMs: utterance.length / context.sampleRate * 1000, silenceMs: endpoint.endSilenceMs,
                earlyId: endpoint.completedEarlyId ?? null });
            }
          };
          node.port.postMessage({ epoch: expected });
          stream.getAudioTracks().forEach((track) => { track.enabled = true; });
        },
        play, settle, readSpeechSample,
        ...(playbackHold ? { holdPlayback: () => playbackHold.hold(), resumePlayback: () => playbackHold.resume() } : {}),
        // Last microphone block's RMS (echo-rejected blocks read as silence), for the avatar.
        readInputLevel: () => (closed ? 0 : endpoint.level)
      };
    } catch (error) { close(); throw error; }
  }

  async function recording(sound, signal) {
    const response = await root.fetch(sound.url, { signal });
    if (!response.ok) throw new Error('Cet enregistrement est indisponible. Réessaie avec le bouton de lecture.');
    return response.arrayBuffer();
  }

  const api = { WakeWindow, recording, AudioHistory, Endpoint, EchoGuard, wav, Conversation, openAudio, speakWithBrowser, isTranscriptHallucination, isSpokenEcho, holdingPhrase, HOLDING_DELAY_MS, MAX_CAPTURE_BYTES, nextSpeechChunkLength };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else { root.AgentXVoice = api; root.NestorConversation = api; }
})(typeof window === 'undefined' ? globalThis : window);
