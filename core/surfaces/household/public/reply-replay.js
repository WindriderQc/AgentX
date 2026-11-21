'use strict';

(function expose(root) {
  const COPY = {
    fr: { listen: 'Réécouter cette réponse', stop: 'Arrêter la relecture', playing: 'Lecture en cours…',
      complete: 'Relecture terminée.', stopped: 'Relecture arrêtée.', busy: 'Mettez la voix en pause pour réécouter cette réponse.',
      failed: 'La relecture a échoué. La réponse reste disponible.' },
    en: { listen: 'Listen to this answer again', stop: 'Stop replay', playing: 'Playing…',
      complete: 'Replay finished.', stopped: 'Replay stopped.', busy: 'Pause voice to listen to this answer again.',
      failed: 'Replay failed. The answer is still available.' }
  };

  function interruptedPlayback(timings) {
    return ['user_paused', 'interrupted'].includes(timings?.playbackOutcome);
  }

  function savedAnswer(turn, session) {
    if (!session?.sessionId || session.ephemeral || turn?.sessionId !== session.sessionId || !turn.clientTurnId
      || turn.channel !== 'voice' || turn.outcome !== 'completed' || turn.interrupted || turn.textRetention !== 'full'
      || !interruptedPlayback(turn.voiceTimings) || !turn.replyText?.trim()) return null;
    return { text: turn.replyText, language: turn.speechLanguage || session.voice?.language,
      speakerAgentId: turn.speakerAgentId, sessionId: session.sessionId };
  }

  function create({ host, base, api, getSession, getLanguage, mayPlay, beforePlay, synthesize,
    speech = root.NestorSpeech, makePlayer = () => new root.VoixAudio.Speech({ retryUnplayed: true }) }) {
    let active, player, reading;
    const copy = () => COPY[getLanguage() === 'en' ? 'en' : 'fr'];
    function stop() {
      reading?.abort();
      reading = null;
      if (!active) return;
      const { button, status } = active;
      active = null;
      player?.cancel();
      button.textContent = copy().listen;
      status.textContent = copy().stopped;
    }

    function bind(row, turn) {
      const answer = savedAnswer(turn, getSession());
      if (!answer || row.querySelector('.conversation-reply-replay')) return;
      const doc = row.ownerDocument, controls = doc.createElement('div');
      controls.className = 'conversation-work-actions conversation-reply-replay';
      const button = doc.createElement('button'), status = doc.createElement('small');
      button.type = 'button';
      button.className = 'button';
      button.textContent = copy().listen;
      status.setAttribute('role', 'status');
      button.onclick = async () => {
        if (active?.button === button) { stop(); return; }
        if (getSession()?.sessionId !== answer.sessionId || !mayPlay()) { status.textContent = copy().busy; return; }
        const segments = speech.splitSpeechText(speech.speechText(answer.text, { readAloud: true }));
        beforePlay();
        stop();
        const request = { button, status };
        active = request;
        button.textContent = copy().stop;
        status.textContent = copy().playing;
        try {
          if (!segments.length) throw Error('No readable answer');
          player ||= makePlayer();
          await player.speak((signal, text, after) => synthesize({ ...answer, text }, signal, after), { segments });
          if (active === request) status.textContent = copy().complete;
        } catch {
          if (active === request) status.textContent = copy().failed;
        } finally {
          if (active === request) { active = null; button.textContent = copy().listen; }
        }
      };
      controls.append(button, status);
      row.append(controls);
    }

    async function refresh(session, turnId, timings) {
      if (session.ephemeral || !interruptedPlayback(timings) || getSession()?.sessionId !== session.sessionId) return;
      const row = [...host.querySelectorAll('.conversation-message.assistant[data-turn]')].find(node => node.dataset.turn === turnId);
      if (!row || row.querySelector('.conversation-reply-replay')) return;
      reading?.abort();
      const request = new AbortController();
      reading = request;
      try {
        const { turn } = await api(`${base}/${encodeURIComponent(session.sessionId)}/history?turnId=${encodeURIComponent(turnId)}`,
          { signal: AbortSignal.any([request.signal, AbortSignal.timeout(5500)]) });
        if (reading === request && host.contains(row) && turn?.clientTurnId === turnId) bind(row, turn);
      } catch { /* The answer can still be restored from its retained conversation. */ }
      finally { if (reading === request) reading = null; }
    }
    return { bind, refresh, stop };
  }

  const api = Object.freeze({ create, savedAnswer });
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.NestorReplyReplay = api;
}(typeof window !== 'undefined' ? window : globalThis));
