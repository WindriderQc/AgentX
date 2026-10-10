/* Local speech transport and playback shared by browser clients. No microphone access. */
(function (root, factory) {
  const api = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.VoixAudio = api;
})(typeof globalThis === 'undefined' ? this : globalThis, function (root) {
  'use strict';
  const abortError = () => Object.assign(new Error('Speech cancelled'), { name: 'AbortError' });
  class Decoder {
    constructor() { this.meta = null; this.frames = 0; this.samples = 0; this.done = false; }
    accept(event) {
      if (this.done) throw new Error('Audio arrived after completion');
      if (event.type === 'meta') {
        if (this.meta || event.protocol !== 'voix-pcm-v1' || event.encoding !== 'f32le' || event.channels !== 1
            || !Number.isInteger(event.sample_rate) || event.sample_rate < 8000 || event.sample_rate > 96000) throw new Error('Invalid speech format');
        this.meta = event;
      } else if (event.type === 'audio') {
        if (!this.meta || event.sequence !== this.frames + 1) throw new Error('Missing or reordered speech frame');
        const bytes = root.atob(event.pcm);
        if (!bytes.length || bytes.length !== event.samples * 4) throw new Error('Invalid speech frame length');
        const raw = Uint8Array.from(bytes, c => c.charCodeAt(0));
        const view = new DataView(raw.buffer);
        const samples = new Float32Array(event.samples);
        for (let i = 0; i < samples.length; i++) {
          samples[i] = view.getFloat32(i * 4, true);
          if (!Number.isFinite(samples[i])) throw new Error('Invalid speech samples');
        }
        this.frames++; this.samples += samples.length;
        return samples;
      } else if (event.type === 'done') {
        if (!this.frames || event.frames !== this.frames || event.samples !== this.samples) throw new Error('Incomplete speech stream');
        this.done = true;
      } else throw new Error(event.type === 'error' ? 'Local speech synthesis failed' : 'Unknown speech event');
      return null;
    }
  }

  class Player {
    constructor(context, { destinations, onReceipt, onMetrics, onScheduled } = {}) {
      this.context = context;
      this.destinations = destinations || [context.destination];
      this.onScheduled = onScheduled || (() => {});
      this.onReceipt = onReceipt || (() => {}); this.onMetrics = onMetrics || (() => {});
    }
    async play(input, signal, { rate = 1, requestStartedAt } = {}) {
      if (signal.aborted) throw abortError();
      const context = this.context, pending = new Set(), nodes = new Set();
      const started = Number.isFinite(requestStartedAt) ? requestStartedAt : root.performance.now();
      let cursor = 0, reader, firstScheduled = null, gapMs = 0, gaps = 0, peakBufferedMs = 0;
      let rejectAbort, scheduled = false;
      const aborted = new Promise((_, reject) => { rejectAbort = reject; });
      aborted.catch(() => {});
      const stopNodes = () => { for (const node of nodes) { try { node.stop(); } catch {} } };
      const abort = () => { stopNodes(); reader?.cancel().catch(() => {}); rejectAbort(abortError()); };
      signal.addEventListener('abort', abort, { once: true });
      const active = () => { if (signal.aborted) throw abortError(); };
      const schedule = async buffer => {
        active();
        while (cursor - context.currentTime > 3 && pending.size) {
          await Promise.race([...pending, aborted]); active();
        }
        if (context.state !== 'running') throw new Error('Audio paused by the browser');
        const node = context.createBufferSource(); node.buffer = buffer;
        const speed = Math.max(0.6, Math.min(1.25, Number(rate) || 1));
        node.playbackRate.value = speed;
        for (const destination of this.destinations) {
          if (destination.node) node.connect(destination.node, 0, destination.input || 0);
          else node.connect(destination);
        }
        const now = context.currentTime;
        if (cursor && cursor < now) { gaps++; gapMs += (now - cursor) * 1000; }
        const at = Math.max(cursor || now + 0.04, now + 0.005);
        if (firstScheduled === null) firstScheduled = root.performance.now() - started;
        cursor = at + buffer.duration / speed;
        peakBufferedMs = Math.max(peakBufferedMs, (cursor - now) * 1000);
        nodes.add(node);
        let resolve;
        const done = new Promise(r => { resolve = r; }); pending.add(done);
        node.onended = () => { node.disconnect(); node.buffer = null; nodes.delete(node); pending.delete(done); resolve(); };
        try { node.start(at); if (!scheduled) { scheduled = true; this.onScheduled(); } }
        catch (error) { node.onended(); throw error; }
      };
      try {
        active();
        const response = await Promise.race([Promise.resolve(input), aborted]); active();
        if (response?.headers?.get('content-type')?.includes('application/x-ndjson')) {
          reader = response.body.getReader();
          const decoder = new Decoder(), utf8 = new TextDecoder();
          let pendingText = '';
          const accept = async line => {
            if (!line.trim()) return;
            const event = JSON.parse(line), samples = decoder.accept(event);
            if (event.type === 'meta') this.onReceipt(event);
            if (samples) {
              const buffer = context.createBuffer(1, samples.length, decoder.meta.sample_rate);
              buffer.copyToChannel(samples, 0);
              await schedule(buffer);
            }
          };
          for (;;) {
            const result = await Promise.race([reader.read(), aborted]); active();
            pendingText += utf8.decode(result.value, { stream: !result.done });
            let newline;
            while ((newline = pendingText.indexOf('\n')) >= 0) {
              await accept(pendingText.slice(0, newline)); pendingText = pendingText.slice(newline + 1);
            }
            if (result.done) break;
          }
          if (pendingText.trim()) await accept(pendingText);
          if (!decoder.done) throw new Error('Speech connection ended before completion');
        } else {
          const bytes = response?.arrayBuffer ? await Promise.race([response.arrayBuffer(), aborted]) : response;
          const buffer = await Promise.race([context.decodeAudioData(bytes), aborted]); active();
          if (response?.headers) this.onReceipt({ provider: response.headers.get('x-voix-provider'),
            voice: decodeURIComponent(response.headers.get('x-voix-voice') || ''), language: response.headers.get('x-voix-language') });
          await schedule(buffer);
        }
        await Promise.race([Promise.all([...pending]), aborted]); active();
        const metrics = { first_scheduled_ms: Math.round(firstScheduled || 0), buffer_gap_ms: Math.round(gapMs),
          buffer_gaps: gaps, peak_buffered_ms: Math.round(peakBufferedMs), basis: 'browser scheduling; not acoustic arrival' };
        this.onMetrics(metrics);
        return metrics;
      } finally {
        signal.removeEventListener('abort', abort); stopNodes();
        if (reader) { await reader.cancel().catch(() => {}); reader.releaseLock(); }
      }
    }
  }

  // A replacement cancels the request as well as every scheduled audio node.
  class Speech {
    constructor(options = {}) { this.options = options; this.current = null; }
    cancel() { this.current?.abort(); this.current = null; }
    async speak(fetchAudio) {
      this.cancel();
      const requestStartedAt = root.performance.now();
      const controller = new AbortController(); this.current = controller;
      const Context = root.AudioContext || root.webkitAudioContext;
      if (!Context) { this.current = null; throw new Error('Audio playback is unavailable'); }
      const context = new Context();
      try {
        await context.resume();
        if (controller.signal.aborted) throw abortError();
        const response = await fetchAudio(controller.signal);
        if (controller.signal.aborted || this.current !== controller) throw abortError();
        return await new Player(context, this.options).play(response, controller.signal, { requestStartedAt });
      } finally {
        if (this.current === controller) this.current = null;
        await context.close().catch(() => {});
      }
    }
  }
  function voiceKey(voice) { return `${voice.provider}|${voice.id}`; }
  function splitVoice(key) {
    const index = String(key || '').indexOf('|');
    return index > 0 ? { provider: key.slice(0, index), voice: key.slice(index + 1) } : null;
  }
  function choices(catalog, language, provider) {
    return (catalog?.voices || []).filter(v => (!language || v.language === language.slice(0, 2)) && (!provider || v.provider === provider));
  }
  return { Decoder, Player, Speech, voiceKey, splitVoice, choices };
});
