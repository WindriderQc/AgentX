/* Reversible playback hold. The microphone clock keeps running. */
(function (root) {
  'use strict';
  class PlaybackHold {
    constructor(context) {
      this.context = context; this.sources = new Set(); this.heldAt = null; this.heldSeconds = 0;
      this.playerContext = new Proxy(context, { get: (target, key) => {
        if (key === 'currentTime') return this.currentTime;
        if (key === 'createBufferSource') return () => this.createSource();
        const value = Reflect.get(target, key, target);
        return typeof value === 'function' ? value.bind(target) : value;
      } });
    }
    get currentTime() { return (this.heldAt ?? this.context.currentTime) - this.heldSeconds; }
    hold() {
      if (this.heldAt !== null) return;
      this.heldAt = this.context.currentTime;
      for (const source of this.sources) source.halt();
    }
    resume() {
      if (this.heldAt === null) return;
      this.heldSeconds += this.context.currentTime - this.heldAt;
      this.heldAt = null;
      for (const source of [...this.sources]) source.run();
    }
    createSource() {
      const owner = this, links = [];
      let actual, started = false, ended = false, at, offset;
      const source = {
        buffer: null, playbackRate: { value: 1 }, onended: null,
        connect(...link) { links.push(link); if (actual) actual.connect(...link); },
        disconnect() { actual?.disconnect(); links.length = 0; },
        halt() {
          if (!actual) return;
          const old = actual; actual = null; old.onended = null;
          try { old.stop(); } catch { /* already ended */ }
          old.disconnect();
        },
        finish() {
          if (ended) return;
          ended = true; source.halt(); owner.sources.delete(source); source.onended?.();
        },
        start(when = owner.currentTime, startOffset = 0) {
          if (started) throw new Error('Playback source already started');
          started = true; at = when; offset = startOffset; owner.sources.add(source); source.run();
        },
        run() {
          if (ended || !started || actual || owner.heldAt !== null) return;
          const speed = source.playbackRate.value;
          const remainingOffset = offset + Math.max(0, owner.currentTime - at) * speed;
          if (remainingOffset >= source.buffer.duration) { source.finish(); return; }
          actual = owner.context.createBufferSource(); actual.buffer = source.buffer;
          actual.playbackRate.value = speed;
          for (const link of links) actual.connect(...link);
          actual.onended = () => source.finish();
          actual.start(owner.context.currentTime + Math.max(0, at - owner.currentTime), remainingOffset);
        },
        stop() { source.finish(); }
      };
      return source;
    }
  }
  if (typeof module !== 'undefined' && module.exports) module.exports = { PlaybackHold };
  else root.NestorPlaybackHold = { PlaybackHold };
})(typeof window === 'undefined' ? globalThis : window);
