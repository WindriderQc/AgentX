/* Local recovery only. Never opens a device, transcribes, or replays a request. */
(function (root) {
  'use strict';
  const RETRY_DELAY_MS = 2000, MAX_RECOGNITION_RECOVERIES = 2;
  const transient = error => error?.name !== 'AbortError' && (
    [408, 429, 502, 503, 504].includes(Number(error?.status))
    || error?.name === 'TypeError' && /network|fetch|load failed/i.test(error.message || ''));

  class VoiceRecovery {
    constructor(conversation) { this.c = conversation; this.reset(); }
    english() { return (this.c.selection || this.c.startSelection)?.language === 'en'; }
    captureMessage() {
      return this.english()
        ? 'Continuous sound exceeded the capture limit. No message was sent to Nestor. Waiting for silence; Pause still turns off the mic.'
        : 'Son continu : limite de capture atteinte. Aucun message envoyé à Nestor. En attente de silence ; Pause coupe toujours le micro.';
    }
    readyMessage() {
      return this.english() ? (this.c.selection?.wakeWord ? 'Mic ready — say “Hey Nestor”.' : 'Mic ready. You can speak.')
        : this.c.selection?.wakeWord ? 'Micro prêt — dites « Hey Nestor ».' : 'Micro prêt. Vous pouvez parler.';
    }
    reset() { this.cancelRecognition(); this.captureWaiting = false; this.failures = 0; }
    userInput() { this.cancelRecognition(); }
    cancelRecognition() { clearTimeout(this.pending?.timer); this.pending = null; }
    capture(event, epoch) {
      const c = this.c;
      if (!c.current(epoch)) return;
      if (event.state === 'waiting-silence') {
        this.c.repairs?.reset(); this.cancelRecognition(); this.captureWaiting = true;
        c.dropEarly(); c.speculative.reset(); c.cancelWakeAck(); c.wake.arm(); c.captureFollowup = false;
        const turn = c.activeTurn;
        if (turn && c.owns(turn)) {
          if (turn.candidate?.held) c.audio.resumePlayback?.();
          c.releaseCandidate(turn);
          c.show(turn.replyStarted ? 'speaking' : 'thinking', this.captureMessage());
        } else c.show('recovering', this.captureMessage());
      } else if (event.state === 'ready' && this.captureWaiting) {
        this.captureWaiting = false;
        const turn = c.activeTurn;
        if (turn && c.owns(turn)) { turn.monitoring = false; c.monitor(turn); }
        else c.listen(epoch, this.readyMessage());
      }
    }
    recognition(error, epoch) {
      const c = this.c;
      if (typeof c.io.canResumeRecognition !== 'function' || !transient(error)
        || this.failures >= MAX_RECOGNITION_RECOVERIES) return false;
      this.c.repairs?.reset(); this.failures++; this.cancelRecognition();
      c.audio.quiet(); c.dropEarly(); c.speculative.reset(); c.cancelWakeAck(); c.wake.arm(); c.captureFollowup = false;
      const pending = { epoch, audio: c.audio, timer: null };
      this.pending = pending;
      const status = error.status ? ' (HTTP ' + Number(error.status) + ')' : '';
      c.show('recovering', this.english()
        ? 'Speech recognition is unavailable' + status + '. No message sent to Nestor. Waiting to resume fresh listening; Pause cancels recovery.'
        : 'Reconnaissance indisponible' + status + '. Aucun message envoyé à Nestor. Reprise de l’écoute en attente ; Pause annule la reprise.');
      pending.resume = () => {
        if (this.pending !== pending || !c.current(epoch) || c.audio !== pending.audio) return;
        let allowed;
        try { allowed = c.io.canResumeRecognition(); } catch (error) { c.fail(error, epoch); return; }
        if (allowed === null) { c.stop(true); return; }
        // An offline page waits for its online event, not an endless polling loop.
        if (!allowed) { pending.timer = null; return; }
        this.pending = null;
        c.listen(epoch, this.readyMessage());
      };
      pending.timer = setTimeout(pending.resume, Math.max(RETRY_DELAY_MS, Math.min(30000, Number(error.retryAfterMs) || 0)));
      return true;
    }
    retry() { if (this.pending) { clearTimeout(this.pending.timer); this.pending.resume(); } }
    reviewMessage(error) {
      if (this.english()) return 'Speech recognition failed. Mic paused. You may replay the excerpt or press Resume; the failed request is not replayed automatically.';
      const status = error?.status ? ' (HTTP ' + Number(error.status) + ')' : '';
      return 'La reconnaissance a échoué' + status + '. Micro en pause. Vous pouvez réécouter l’extrait ou appuyer sur Reprendre ; aucun renvoi automatique.';
    }
    failureMessage(error) {
      if (this.english()) return error?.message || 'Voice stopped. Press Resume when ready.';
      if (error?.name === 'NotAllowedError') return 'Le navigateur refuse l’accès au micro ou au son. Vérifiez son autorisation, puis appuyez sur Reprendre.';
      if (error?.name === 'NotFoundError' || error?.code === 'VOICE_DEVICE_DISCONNECTED') return 'Micro introuvable ou déconnecté. Rebranchez-le, puis appuyez sur Reprendre.';
      if (['VOICE_CONTEXT_PAUSED', 'VOICE_AUTOPLAY_BLOCKED'].includes(error?.code)) return 'Le navigateur a suspendu le son. Appuyez sur Reprendre pour continuer.';
      if (error?.code === 'VOICE_START_TIMEOUT') return 'Le micro ne démarre pas. Vérifiez sa connexion et son autorisation, puis appuyez sur Reprendre.';
      if (transient(error)) return 'Connexion vocale interrompue. La demande en cours n’est pas renvoyée automatiquement. Appuyez sur Reprendre.';
      return 'La voix s’est arrêtée. Appuyez sur Reprendre. Détail : ' + (error?.message || 'erreur inconnue');
    }
  }
  const api = { VoiceRecovery, RETRY_DELAY_MS, MAX_RECOGNITION_RECOVERIES, transient };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.AgentXVoiceRecovery = api;
})(typeof window === 'undefined' ? globalThis : window);
