/* Device check (/device-check): the Surface Phase 0 physical-evidence page.
   It runs live browser checks on this device, collects the adult-confirmed
   whole-panel checks and records an acceptance receipt through Core.
   app.js routes here and lends its shared helpers through ctx. */
(function () {
  let app, esc, state, api, toast, transcribe, stopPlayback, setRuntime;

  function deviceTemplate() {
    return `<section class="hero device-hero"><div class="hero-copy"><p class="eyebrow">Surface Phase 0 · physical evidence</p><h1>Prove this device.</h1><p class="lede">Run every check on the real household Surface. Browser observations and explicit physical confirmations become one bounded receipt; no audio or transcript is retained.</p><div class="row wrap"><a class="button" href="/panel">Open Panel</a><a class="button" href="/lecture">Open Reader</a><a class="button" href="/dad/family">Open Journal</a></div></div><aside class="hero-copy hero-status"><div><span id="deviceStatus" class="pill">loading contract</span><p id="deviceLatest" class="muted">No physical claim has been made.</p></div><div><strong id="deviceProgress">0/0</strong><span class="muted"> checks witnessed</span></div></aside></section>
      <section class="device-layout"><article class="card full"><div class="row"><div class="grow"><p class="card-kicker">Privacy-safe run</p><h2>Device identity</h2><p class="muted">Use a stable label and the name of the adult physically witnessing this run. Partial progress stays only in this browser tab; a refresh can resume the same run for up to two hours, and no partial receipt reaches the server.</p></div><span class="pill">push-to-talk only</span></div><div class="acceptance-fields"><label><span>Device label</span><input id="deviceLabel" value="Household Surface" maxlength="80" autocomplete="off"></label><label><span>Confirmed by</span><input id="deviceConfirmedBy" maxlength="60" placeholder="Adult witness" autocomplete="off"></label></div></article>
      <article class="card full"><p class="card-kicker">Browser witnessed</p><h2>Live device checks</h2><p class="muted">These controls require real browser events. A mouse click does not count as touch, and typing does not count as a reconnect or resume.</p><div id="deviceObserved" class="acceptance-grid"></div></article>
      <article class="card full"><p class="card-kicker">Adult confirmed</p><h2>Whole-panel checks</h2><p class="muted">Complete the linked Panel, Reader, Journal, secretary, output-device, and admin-verifier steps before checking these declarations.</p><div id="deviceConfirmed" class="acceptance-grid"></div></article>
      <article class="card full"><div class="row"><div class="grow"><p class="card-kicker">Separate native capability</p><h2>Wake gate stays outside Phase 0</h2><p class="muted">The native VoiX wake gate is available after an explicit session start and has its own acoustic acceptance. It does not count toward this Surface push-to-talk receipt.</p></div><span class="pill ok">available separately</span></div></article>
      <article class="card full acceptance-submit"><div><h2>Record the receipt</h2><p class="muted">The button stays closed until all checks pass and both identity fields are filled. Submission stores evidence labels, timestamps, device facts, and a SHA-256 fingerprint—never audio or recognized words.</p></div><button id="deviceSubmit" class="primary" disabled>Record Phase 0 acceptance</button></article></section>`;
  }

  async function loadDeviceCheck() {
    const draftKey = 'agentx:surface-phase0-draft:v1';
    const draftMaxAgeMs = 2 * 60 * 60 * 1000;
    const alwaysRecheck = new Set(['trusted_https', 'viewport_layout']);
    app.innerHTML = deviceTemplate();
    let runStartedAt = new Date();
    let runId = globalThis.crypto?.randomUUID
      ? globalThis.crypto.randomUUID()
      : `${Date.now().toString(16)}-${Math.random().toString(16).slice(2)}-${Math.random().toString(16).slice(2)}`;
    const evidence = new Map();
    let requirements = [];
    let captureBusy = false;
    let speakerFinished = false;
    let muteAudio = null;
    let offlineSeenAt = null;
    let hiddenSeen = false;

    const observedControls = {
      trusted_https: '<p>Checked automatically from this page.</p>',
      viewport_layout: '<p>Checked automatically after the acceptance layout renders.</p>',
      microphone_transcription: '<p>Say a short phrase. The live waveform proves that this device is hearing you; only the recognized word count is kept in this page.</p><div class="mic-waveform-shell"><canvas id="deviceMicWaveform" class="mic-waveform" width="640" height="96" aria-label="Live microphone waveform"></canvas><span id="deviceMicSignal" class="mic-signal" aria-live="polite">The waveform appears only while recording and is not retained.</span></div><button id="deviceMic">Start microphone</button>',
      microphone_mute: '<p>Start a capture, watch for a live signal, then mute it. The sample is discarded without transcription.</p><div class="mic-waveform-shell"><canvas id="deviceMuteWaveform" class="mic-waveform" width="640" height="96" aria-label="Live mute-test waveform"></canvas><span id="deviceMuteSignal" class="mic-signal" aria-live="polite">No recording is kept and this test never requests transcription.</span></div><button id="deviceMicMute">Start mute test</button>',
      speaker_playback: '<p>Play the fixed local phrase, then confirm that you heard it from the intended speaker.</p><div class="row wrap"><button id="deviceSpeaker">Play phrase</button><label class="inline-check"><input id="deviceSpeakerHeard" type="checkbox" disabled> I heard the whole phrase</label></div>',
      output_mute: '<p>Start the longer phrase, wait for sound, then stop it while it is speaking.</p><div class="row wrap"><button id="deviceMuteStart">Start mute test</button><button id="deviceMuteStop" disabled>Stop sound now</button></div>',
      touch_input: '<p>Touch the pad with a finger. Mouse and trackpad events are ignored.</p><button id="deviceTouchPad" class="interaction-pad">Touch here</button>',
      keyboard_input: '<p>Focus this field and press any letter or number.</p><input id="deviceKeyboard" maxlength="1" placeholder="Press one key" autocomplete="off">',
      offline_recovery: '<p>With no capture or audio active, disconnect networking, wait for the offline state, reconnect, and leave this page open.</p><span id="deviceNetworkHint" class="muted">Waiting for a real offline event…</span>',
      resume_recovery: '<p>Lock/sleep the Surface or switch away, then return to this page. A successful Panel status read completes the check.</p><span id="deviceResumeHint" class="muted">Waiting for hidden → visible…</span>'
    };
    const confirmationText = {
      kiosk_launch: 'I cold-booted this Surface: the dedicated session reached full-screen Panel with no certificate warning.',
      reader_journal: 'I used Reader by touch and opened Journal with both touch and keyboard.',
      secretary_flow: 'I created one unique disposable personal task and proved the two-touch completion removed only that task.',
      output_device: 'I changed the Windows default output device and the next Nestor phrase followed it.',
      family_surface: 'I closed diagnostics and confirmed that operator links and detailed service cards stayed out of the family home.',
      admin_verifier: 'From the admin PC, verify-post-reboot.ps1 reported every automated check PASS for this Surface.'
    };

    function checkCard(requirement, content) {
      return `<section class="acceptance-check" data-check="${esc(requirement.id)}"><div class="check-heading"><strong>${esc(requirement.label)}</strong><span class="pill">waiting</span></div>${content}</section>`;
    }

    function updateProgress() {
      const passed = requirements.filter((requirement) => evidence.has(requirement.id)).length;
      document.getElementById('deviceProgress').textContent = `${passed}/${requirements.length}`;
      const identityReady = document.getElementById('deviceLabel').value.trim().length >= 2
        && document.getElementById('deviceConfirmedBy').value.trim().length >= 2;
      document.getElementById('deviceSubmit').disabled = passed !== requirements.length || !identityReady;
    }

    function requirementSignature() {
      return requirements.map((requirement) => `${requirement.id}:${requirement.mode}`).join('|');
    }

    function clearDraft() {
      try { sessionStorage.removeItem(draftKey); } catch (_error) { /* storage can be unavailable */ }
    }

    function persistDraft() {
      if (!requirements.length) return;
      try {
        const checks = requirements
          .filter((requirement) => !alwaysRecheck.has(requirement.id) && evidence.has(requirement.id))
          .map((requirement) => {
            const check = evidence.get(requirement.id);
            return {
              id: check.id,
              passed: true,
              evidenceCode: check.evidenceCode,
              observedAt: check.observedAt
            };
          });
        sessionStorage.setItem(draftKey, JSON.stringify({
          schemaVersion: 1,
          origin: location.origin,
          requirementSignature: requirementSignature(),
          runId,
          startedAt: runStartedAt.toISOString(),
          savedAt: new Date().toISOString(),
          deviceLabel: document.getElementById('deviceLabel').value.slice(0, 80),
          confirmedBy: document.getElementById('deviceConfirmedBy').value.slice(0, 60),
          checks
        }));
      } catch (_error) { /* the physical run remains usable without storage */ }
    }

    function renderRequirementState(requirementId, passed) {
      const card = document.querySelector(`[data-check="${requirementId}"]`);
      if (!card) return;
      card.classList.toggle('passed', passed);
      const pill = card.querySelector('.pill');
      pill.textContent = passed ? 'passed' : 'waiting';
      pill.className = passed ? 'pill ok' : 'pill';
    }

    function restoreDraft() {
      let draft;
      try {
        const serialized = sessionStorage.getItem(draftKey);
        if (!serialized) return 0;
        draft = JSON.parse(serialized);
      } catch (_error) {
        clearDraft();
        return 0;
      }

      const startedAtMs = Date.parse(draft?.startedAt);
      const now = Date.now();
      const validEnvelope = draft?.schemaVersion === 1
        && draft.origin === location.origin
        && draft.requirementSignature === requirementSignature()
        && typeof draft.runId === 'string'
        && /^[a-f0-9-]{20,80}$/i.test(draft.runId)
        && Number.isFinite(startedAtMs)
        && startedAtMs <= now + 5 * 60 * 1000
        && now - startedAtMs <= draftMaxAgeMs
        && typeof draft.deviceLabel === 'string'
        && draft.deviceLabel.length <= 80
        && typeof draft.confirmedBy === 'string'
        && draft.confirmedBy.length <= 60
        && Array.isArray(draft.checks);
      if (!validEnvelope) {
        clearDraft();
        return 0;
      }

      const requirementById = new Map(requirements.map((requirement) => [requirement.id, requirement]));
      const uniqueIds = new Set();
      const validChecks = draft.checks.every((check) => {
        const requirement = requirementById.get(check?.id);
        const observedAtMs = Date.parse(check?.observedAt);
        if (!requirement || alwaysRecheck.has(requirement.id) || uniqueIds.has(requirement.id)) return false;
        uniqueIds.add(requirement.id);
        return check.passed === true
          && check.evidenceCode === `${requirement.mode}:${requirement.id}`
          && Number.isFinite(observedAtMs)
          && observedAtMs >= startedAtMs
          && observedAtMs <= now + 5 * 60 * 1000;
      });
      if (!validChecks) {
        clearDraft();
        return 0;
      }

      runId = draft.runId;
      runStartedAt = new Date(startedAtMs);
      document.getElementById('deviceLabel').value = draft.deviceLabel;
      document.getElementById('deviceConfirmedBy').value = draft.confirmedBy;
      draft.checks.forEach((check) => {
        evidence.set(check.id, check);
        renderRequirementState(check.id, true);
        const confirmation = document.querySelector(`[data-confirm-check="${check.id}"]`);
        if (confirmation) confirmation.checked = true;
      });
      return draft.checks.length;
    }

    function mark(requirementId, detail) {
      if (!requirements.some((requirement) => requirement.id === requirementId)) return;
      evidence.set(requirementId, {
        id: requirementId,
        passed: true,
        evidenceCode: `${requirements.find((requirement) => requirement.id === requirementId).mode}:${requirementId}`,
        localDetail: String(detail || 'passed').slice(0, 180),
        observedAt: new Date().toISOString()
      });
      renderRequirementState(requirementId, true);
      persistDraft();
      updateProgress();
    }

    function unmark(requirementId) {
      evidence.delete(requirementId);
      renderRequirementState(requirementId, false);
      persistDraft();
      updateProgress();
    }

    function cleanupAcceptanceAudio(audio, url) {
      if (state.activeAudio === audio) state.activeAudio = null;
      if (state.activeAudioUrl === url) state.activeAudioUrl = null;
      URL.revokeObjectURL(url);
    }

    function startAcceptanceWaveform(stream, canvasId, statusId) {
      const canvas = document.getElementById(canvasId);
      const status = document.getElementById(statusId);
      const AudioContextClass = window.AudioContext || window.webkitAudioContext;
      if (!canvas || !AudioContextClass) {
        if (status) status.textContent = 'Live waveform unavailable; capture can still complete safely.';
        return { stop: async () => {} };
      }

      let context;
      let source;
      let analyser;
      let animationFrame = 0;
      let stopped = false;
      let signalSeen = false;
      const drawContext = canvas.getContext('2d');
      if (!drawContext) {
        if (status) status.textContent = 'Live waveform unavailable; capture can still complete safely.';
        return { stop: async () => {} };
      }

      try {
        context = new AudioContextClass();
        source = context.createMediaStreamSource(stream);
        analyser = context.createAnalyser();
        analyser.fftSize = 512;
        analyser.smoothingTimeConstant = 0.72;
        source.connect(analyser);
        context.resume().catch(() => {});
      } catch (_error) {
        context?.close().catch(() => {});
        if (status) status.textContent = 'Live waveform unavailable; capture can still complete safely.';
        return { stop: async () => {} };
      }

      const samples = new Uint8Array(analyser.fftSize);
      const draw = () => {
        if (stopped) return;
        analyser.getByteTimeDomainData(samples);
        let peak = 0;
        for (const value of samples) peak = Math.max(peak, Math.abs(value - 128));
        if (peak >= 4) signalSeen = true;

        drawContext.clearRect(0, 0, canvas.width, canvas.height);
        drawContext.fillStyle = '#07131d';
        drawContext.fillRect(0, 0, canvas.width, canvas.height);
        drawContext.strokeStyle = signalSeen ? '#55d9d0' : '#7693a5';
        drawContext.lineWidth = 3;
        drawContext.beginPath();
        const sliceWidth = canvas.width / Math.max(1, samples.length - 1);
        samples.forEach((value, index) => {
          const x = index * sliceWidth;
          const y = (value / 255) * canvas.height;
          if (index === 0) drawContext.moveTo(x, y);
          else drawContext.lineTo(x, y);
        });
        drawContext.stroke();
        canvas.classList.toggle('signal-seen', signalSeen);
        const signalMessage = signalSeen
          ? 'Voice signal detected live. Nothing from this waveform is retained.'
          : 'Listening for a voice signal…';
        if (status && status.textContent !== signalMessage) status.textContent = signalMessage;
        animationFrame = requestAnimationFrame(draw);
      };
      draw();

      return {
        signalSeen: () => signalSeen,
        stop: async (message = 'Capture stopped. Waveform discarded.') => {
          if (stopped) return;
          stopped = true;
          cancelAnimationFrame(animationFrame);
          source.disconnect();
          analyser.disconnect();
          samples.fill(128);
          canvas.classList.remove('signal-seen');
          drawContext.clearRect(0, 0, canvas.width, canvas.height);
          if (context.state !== 'closed') await context.close().catch(() => {});
          if (status) status.textContent = message;
        }
      };
    }

    async function acceptanceAudio(text, languageHint = '') {
      stopPlayback();
      const profile = window.NestorSpeech.speechProfile(text, languageHint);
      const response = await fetch('/api/voix/synthesize', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text, language: profile.language, voice: profile.nativeVoice, response_format: 'wav' })
      });
      if (!response.ok) throw new Error('Local Nestor speech is unavailable');
      const url = URL.createObjectURL(await response.blob());
      const audio = new Audio(url);
      state.activeAudio = audio;
      state.activeAudioUrl = url;
      return { audio, url };
    }

    async function recover(checkId, hintId, detail) {
      const hint = document.getElementById(hintId);
      try {
        await api('/api/panel/status');
        mark(checkId, detail);
        if (hint) hint.textContent = 'Panel status recovered successfully.';
      } catch (error) {
        if (hint) hint.textContent = `Recovery read failed: ${error.message}. Repeat the cycle.`;
      }
    }

    const acceptance = await api('/api/household/device-acceptance/contract');
    requirements = acceptance.checks || [];
    document.getElementById('deviceStatus').textContent = acceptance.latest ? 'prior receipt exists' : 'physical acceptance pending';
    document.getElementById('deviceStatus').className = `pill ${acceptance.latest ? 'ok' : 'down'}`;
    document.getElementById('deviceLatest').textContent = acceptance.latest
      ? `${acceptance.latest.deviceLabel} passed ${new Date(acceptance.latest.completedAt).toLocaleString()} · ${acceptance.latest.fingerprint.slice(0, 12)}`
      : 'No stored Phase 0 receipt. This page does not infer a pass from software deployment.';
    document.getElementById('deviceObserved').innerHTML = requirements
      .filter((requirement) => requirement.mode === 'observed')
      .map((requirement) => checkCard(requirement, observedControls[requirement.id] || '<p>Browser observation required.</p>')).join('');
    document.getElementById('deviceConfirmed').innerHTML = requirements
      .filter((requirement) => requirement.mode === 'confirmed')
      .map((requirement) => checkCard(requirement, `<label class="confirmation"><input type="checkbox" data-confirm-check="${esc(requirement.id)}"> <span>${esc(confirmationText[requirement.id] || requirement.label)}</span></label>`)).join('');

    const restoredChecks = restoreDraft();
    const exactHttps = window.isSecureContext && location.protocol === 'https:';
    if (exactHttps) mark('trusted_https', `secure HTTPS origin ${location.origin}`);
    const fits = document.documentElement.scrollWidth <= window.innerWidth + 2;
    if (fits) mark('viewport_layout', `${window.innerWidth}x${window.innerHeight} CSS px; no horizontal overflow`);
    if (restoredChecks) toast(`Restored ${restoredChecks} physical check(s) from this tab. HTTPS and layout were rechecked now.`);

    document.querySelectorAll('[data-confirm-check]').forEach((input) => input.addEventListener('change', () => {
      if (input.checked) mark(input.dataset.confirmCheck, 'adult witness explicitly confirmed the displayed declaration');
      else unmark(input.dataset.confirmCheck);
    }));
    ['deviceLabel', 'deviceConfirmedBy'].forEach((id) => document.getElementById(id).addEventListener('input', () => {
      persistDraft();
      updateProgress();
    }));

    document.getElementById('deviceTouchPad').addEventListener('pointerdown', (event) => {
      if (event.pointerType === 'touch') mark('touch_input', 'browser received pointerType=touch on the acceptance pad');
      else toast('That was not a touch event. Use a finger on the Surface screen.');
    });
    document.getElementById('deviceKeyboard').addEventListener('keydown', (event) => {
      if (event.key.length === 1) mark('keyboard_input', `physical keyboard event observed for key class ${/\d/.test(event.key) ? 'number' : 'character'}`);
    });

    const microphoneButton = document.getElementById('deviceMic');
    microphoneButton.addEventListener('click', async () => {
      if (microphoneButton.recording) {
        microphoneButton.recording.stop();
        return;
      }
      if (captureBusy) return toast('Finish the current microphone check first.');
      let stream = null;
      let waveform = null;
      try {
        captureBusy = true;
        stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        waveform = startAcceptanceWaveform(stream, 'deviceMicWaveform', 'deviceMicSignal');
        const chunks = [];
        const recorder = new MediaRecorder(stream);
        microphoneButton.recording = recorder;
        recorder.addEventListener('dataavailable', (event) => { if (event.data.size) chunks.push(event.data); });
        recorder.addEventListener('stop', async () => {
          stream.getTracks().forEach((track) => track.stop());
          await waveform.stop('Capture stopped. Transcribing locally; waveform discarded.');
          microphoneButton.recording = null;
          microphoneButton.disabled = true;
          microphoneButton.textContent = 'Transcribing locally…';
          try {
            const text = await transcribe(new Blob(chunks, { type: recorder.mimeType || 'audio/webm' }));
            const words = text.trim().split(/\s+/).filter(Boolean).length;
            if (!words) throw new Error('No words were recognized');
            mark('microphone_transcription', `local transcription returned ${words} recognized word(s); words not retained`);
            microphoneButton.textContent = 'Microphone passed';
            document.getElementById('deviceMicSignal').textContent = `${words} word(s) recognized locally. Audio, transcript, and waveform were not retained.`;
          } catch (error) {
            microphoneButton.disabled = false;
            microphoneButton.textContent = 'Retry microphone';
            document.getElementById('deviceMicSignal').textContent = `No usable transcription returned: ${error.message}`;
            toast(error.message);
          } finally { captureBusy = false; }
        });
        recorder.start();
        microphoneButton.textContent = 'Stop and transcribe';
      } catch (error) {
        stream?.getTracks().forEach((track) => track.stop());
        await waveform?.stop('Capture failed. No waveform was retained.');
        captureBusy = false;
        toast(error.message);
      }
    });

    const muteMicButton = document.getElementById('deviceMicMute');
    muteMicButton.addEventListener('click', async () => {
      if (muteMicButton.recording) {
        muteMicButton.discard = true;
        muteMicButton.recording.stop();
        return;
      }
      if (captureBusy) return toast('Finish the current microphone check first.');
      let stream = null;
      let waveform = null;
      try {
        captureBusy = true;
        stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        waveform = startAcceptanceWaveform(stream, 'deviceMuteWaveform', 'deviceMuteSignal');
        const recorder = new MediaRecorder(stream);
        muteMicButton.recording = recorder;
        muteMicButton.discard = false;
        recorder.addEventListener('stop', async () => {
          stream.getTracks().forEach((track) => track.stop());
          await waveform.stop('Capture discarded without transcription. Waveform discarded too.');
          muteMicButton.recording = null;
          if (muteMicButton.discard) {
            mark('microphone_mute', 'active MediaRecorder stopped and sample was discarded before any transcription request');
            muteMicButton.textContent = 'Mute/discard passed';
            muteMicButton.disabled = true;
          }
          else {
            muteMicButton.textContent = 'Retry mute test';
            document.getElementById('deviceMuteSignal').textContent = 'Capture ended before explicit discard. Repeat this check.';
          }
          captureBusy = false;
        });
        recorder.start();
        muteMicButton.textContent = 'Mute and discard now';
      } catch (error) {
        stream?.getTracks().forEach((track) => track.stop());
        await waveform?.stop('Capture failed. No waveform was retained.');
        captureBusy = false;
        toast(error.message);
      }
    });

    const speakerButton = document.getElementById('deviceSpeaker');
    const speakerHeard = document.getElementById('deviceSpeakerHeard');
    speakerButton.addEventListener('click', async () => {
      speakerFinished = false;
      speakerHeard.checked = false;
      speakerHeard.disabled = true;
      unmark('speaker_playback');
      try {
        const { audio, url } = await acceptanceAudio('Bonjour. Nestor parle maintenant sur le haut-parleur choisi.', 'fr');
        audio.addEventListener('ended', () => {
          speakerFinished = true;
          speakerHeard.disabled = false;
          cleanupAcceptanceAudio(audio, url);
          toast('Playback finished. Confirm only if you heard the whole phrase.');
        }, { once: true });
        await audio.play();
      } catch (error) {
        stopPlayback();
        toast(error.message);
      }
    });
    speakerHeard.addEventListener('change', () => {
      if (speakerHeard.checked && speakerFinished) mark('speaker_playback', 'fixed local phrase completed and adult witness confirmed it was audible');
      else unmark('speaker_playback');
    });

    const muteStart = document.getElementById('deviceMuteStart');
    const muteStop = document.getElementById('deviceMuteStop');
    muteStart.addEventListener('click', async () => {
      unmark('output_mute');
      muteStop.disabled = true;
      try {
        muteAudio = await acceptanceAudio('Ceci est le test de coupure du son. La phrase continue assez longtemps pour que tu puisses arrêter la lecture immédiatement avec le bouton visible.', 'fr');
        muteAudio.audio.addEventListener('timeupdate', () => {
          if (muteAudio && muteAudio.audio.currentTime > 0.1) muteStop.disabled = false;
        });
        const currentMuteAudio = muteAudio;
        muteAudio.audio.addEventListener('ended', () => {
          if (muteAudio === currentMuteAudio) {
            cleanupAcceptanceAudio(currentMuteAudio.audio, currentMuteAudio.url);
            muteAudio = null;
            muteStop.disabled = true;
            toast('The phrase ended before mute was observed. Start the test again.');
          }
        }, { once: true });
        await muteAudio.audio.play();
      } catch (error) { stopPlayback(); muteAudio = null; toast(error.message); }
    });
    muteStop.addEventListener('click', () => {
      if (!muteAudio || muteAudio.audio.currentTime <= 0.1) return;
      const { audio, url } = muteAudio;
      audio.pause();
      const stoppedAt = audio.currentTime;
      const stopped = audio.paused;
      audio.removeAttribute('src');
      audio.load();
      cleanupAcceptanceAudio(audio, url);
      muteAudio = null;
      muteStop.disabled = true;
      if (stopped) mark('output_mute', `active browser audio paused at ${stoppedAt.toFixed(2)} seconds and source was cleared`);
    });

    window.addEventListener('offline', () => {
      offlineSeenAt = new Date();
      document.getElementById('deviceNetworkHint').textContent = 'Offline observed. Reconnect networking now…';
    });
    window.addEventListener('online', () => {
      if (offlineSeenAt) recover('offline_recovery', 'deviceNetworkHint', `offline event followed by online event and healthy Panel read after ${Math.max(1, Math.round((Date.now() - offlineSeenAt.getTime()) / 1000))}s`);
    });
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) {
        hiddenSeen = true;
        document.getElementById('deviceResumeHint').textContent = 'Hidden state observed. Return to this page…';
      } else if (hiddenSeen) {
        recover('resume_recovery', 'deviceResumeHint', 'hidden state followed by visible state and healthy Panel read');
      }
    });

    document.getElementById('deviceSubmit').addEventListener('click', async () => {
      const button = document.getElementById('deviceSubmit');
      button.disabled = true;
      try {
        const result = await api('/api/household/device-acceptance/receipts', {
          method: 'POST',
          body: JSON.stringify({
            runId,
            deviceLabel: document.getElementById('deviceLabel').value,
            confirmedBy: document.getElementById('deviceConfirmedBy').value,
            startedAt: runStartedAt.toISOString(),
            origin: location.origin,
            clientInfo: {
              platform: navigator.userAgentData?.platform || navigator.platform || 'unknown',
              locale: navigator.language || 'unknown',
              viewportWidth: window.innerWidth,
              viewportHeight: window.innerHeight,
              devicePixelRatio: window.devicePixelRatio || 1,
              secureContext: window.isSecureContext
            },
            checks: requirements.map((requirement) => {
              const check = evidence.get(requirement.id);
              return {
                id: check.id,
                passed: check.passed,
                evidenceCode: check.evidenceCode,
                observedAt: check.observedAt
              };
            })
          })
        });
        document.getElementById('deviceStatus').textContent = 'Phase 0 passed';
        document.getElementById('deviceStatus').className = 'pill ok';
        document.getElementById('deviceLatest').textContent = `${result.receipt.deviceLabel} · ${result.receipt.fingerprint}`;
        button.textContent = 'Acceptance recorded';
        clearDraft();
        setRuntime(true, 'device accepted');
      } catch (error) {
        toast(error.message);
        updateProgress();
      }
    });
    updateProgress();
    setRuntime(true, acceptance.latest ? 'prior device receipt' : 'device gate open');
  }

  window.HouseholdDeviceCheck = {
    load(ctx) {
      ({ app, esc, state, api, toast, transcribe, stopPlayback, setRuntime } = ctx);
      return loadDeviceCheck();
    }
  };
})();
