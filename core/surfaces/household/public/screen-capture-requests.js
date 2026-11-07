/* An agent can request a capture. Only a person's click opens the browser chooser. */
(function (root) {
  'use strict';
  function mount({ host, api, base, getSession, busy, addCapture, hasCapture, removeCapture, intervalMs = 2000 }) {
    const card = document.createElement('section'); card.className = 'conversation-board'; card.hidden = true;
    card.setAttribute('aria-label', 'Nestor screen capture request');
    const title = document.createElement('p'), status = document.createElement('p'); status.setAttribute('role', 'status');
    const choose = document.createElement('button'), decline = document.createElement('button');
    for (const button of [choose, decline]) { button.type = 'button'; button.className = 'button'; }
    choose.textContent = 'Choose screen or window'; decline.textContent = 'Decline';
    card.append(title, status, choose, decline); host.before(card);
    let captureApi, timer, controller, pollController, closed = false, currentSession = null, request = null, polling = false, generation = 0;
    const url = sessionId => `${base}/${encodeURIComponent(sessionId)}/screen-capture`;
    const activeSession = () => { const session = getSession(); return session && !session.ephemeral ? session.sessionId : null; };
    function reset() {
      generation++; controller?.abort(); pollController?.abort(); controller = null; request = null; card.hidden = true;
    }
    function render() {
      card.hidden = !request;
      if (!request) return;
      title.textContent = 'Nestor asks for a snapshot: ' + request.purpose;
      const supported = captureApi?.screenCaptureSupported();
      choose.textContent = controller ? 'Cancel capture' : 'Choose screen or window';
      choose.disabled = !supported || (!controller && (busy() || hasCapture(request.requestId)));
      decline.disabled = Boolean(controller);
    }
    async function tick() {
      if (closed || polling) return;
      polling = true;
      try {
        const id = activeSession();
        if (id !== currentSession) { reset(); currentSession = id; }
        if (!id || document.hidden) return;
        const epoch = generation;
        pollController = new AbortController();
        const timeout = setTimeout(() => pollController?.abort(), 8000);
        let result;
        try { result = await api(url(id), { signal: pollController.signal }); }
        finally { clearTimeout(timeout); pollController = null; }
        if (closed || epoch !== generation || activeSession() !== id) return;
        const next = result.request;
        if (request?.requestId !== next?.requestId) {
          controller?.abort(); controller = null;
          status.textContent = next ? 'Choose what to share. One snapshot, no audio. Review the preview, then send it with a message.' : '';
        }
        request = next;
        render();
        if (request && captureApi && !captureApi.screenCaptureSupported()) status.textContent = captureApi.captureErrorMessage({ name: 'NotSupportedError' });
      } catch { /* A failed read is not consent or an attachment receipt. */ }
      finally { polling = false; if (!closed) timer = setTimeout(tick, intervalMs); }
    }
    choose.onclick = async () => {
      if (controller) { controller.abort(); controller = null; status.textContent = 'Capture cancelled. Close the browser chooser if it is still open.'; render(); return; }
      if (!request || !captureApi || controller || busy()) return;
      const selected = request, id = currentSession, epoch = generation;
      const operation = new AbortController(); controller = operation;
      // No await precedes this call: getDisplayMedia requires user activation.
      const pending = captureApi.captureScreen(operation.signal);
      status.textContent = 'Choose a screen, window or tab in the browser. Audio is off.'; render();
      try {
        const snapshot = await pending;
        if (closed || generation !== epoch || controller !== operation || activeSession() !== id || request?.requestId !== selected.requestId) return;
        addCapture(snapshot, selected, id);
        status.textContent = 'Snapshot ready in the attachment draft. Sharing stopped. Add a message and press Send to share it with Nestor.';
      } catch (error) { if (generation === epoch && controller === operation) status.textContent = captureApi.captureErrorMessage(error); }
      finally { if (controller === operation) { controller = null; render(); } }
    };
    decline.onclick = async () => {
      if (!request || controller) return;
      const selected = request, id = currentSession, epoch = generation;
      try {
        await api(url(id), { method: 'POST', body: JSON.stringify({ requestId: selected.requestId, status: 'declined' }) });
        if (epoch === generation) { removeCapture(selected.requestId); reset(); render(); }
      } catch { if (epoch === generation) status.textContent = 'Decline could not be confirmed. Try again.'; }
    };
    import('/js/chat/screen-capture.js').then(value => { captureApi = value; render(); }).catch(() => {
      status.textContent = 'Screen capture could not be loaded. Refresh the page to try again.';
    });
    const pagehide = () => reset();
    root.addEventListener('pagehide', pagehide);
    timer = setTimeout(tick, 0);
    return { reset, dispose() { closed = true; clearTimeout(timer); reset(); card.remove(); root.removeEventListener('pagehide', pagehide); } };
  }
  root.NestorScreenCapture = { mount };
})(window);
