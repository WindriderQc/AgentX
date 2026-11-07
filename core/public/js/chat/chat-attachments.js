import { captureScreen, captureErrorMessage, screenCaptureSupported } from './screen-capture.js';
import { errorFromResponse } from './chat-turn-outcome.js';

export function attachmentUrl(conversationId, attachmentId) {
  if (!/^[a-f0-9]{24}$/.test(conversationId || '') || !/^[a-f0-9]{24}$/.test(attachmentId || '')) return null;
  return `/api/history/${conversationId}/attachments/${attachmentId}`;
}

export function renderAttachments(parent, attachments, conversationId) {
  for (const file of attachments || []) {
    const url = attachmentUrl(conversationId, file.id);
    if (!url) continue;
    const link = document.createElement('a');
    link.href = url;
    link.target = '_blank';
    link.rel = 'noopener';
    link.textContent = file.name;
    if (file.kind === 'image') {
      const image = document.createElement('img');
      image.src = url;
      image.alt = file.name;
      image.loading = 'lazy';
      image.style.maxWidth = 'min(100%, 320px)';
      image.style.maxHeight = '200px';
      link.prepend(image);
    }
    const row = document.createElement('div');
    row.className = 'chat-attachment';
    row.append(link);
    parent.append(row);
  }
}

export function initScreenCapture(state, doc = document) {
  const button = doc.getElementById('captureScreenBtn');
  const status = doc.getElementById('captureScreenStatus');
  const draft = doc.getElementById('captureScreenDraft');
  if (!button || !status || !draft) return null;
  let items = [], operation = null, uploadController = null;
  const supported = screenCaptureSupported();
  function render() {
    if (!supported) status.textContent = captureErrorMessage({ name: 'NotSupportedError' });
    button.textContent = operation ? 'Cancel capture' : 'Capture screen';
    button.disabled = !supported || (!operation && items.length >= 3) || Boolean(uploadController);
    draft.replaceChildren();
    for (const item of items) {
      const row = doc.createElement('div');
      const image = doc.createElement('img');
      image.src = item.dataUrl;
      image.alt = 'Screen snapshot draft';
      image.style.maxWidth = '160px';
      image.style.maxHeight = '100px';
      const remove = doc.createElement('button');
      remove.type = 'button';
      remove.className = 'ghost small';
      remove.textContent = 'Remove snapshot';
      remove.disabled = Boolean(uploadController);
      remove.addEventListener('click', () => {
        items = items.filter(value => value !== item);
        render();
        status.textContent = 'Snapshot removed from the draft.';
      });
      row.append(image, remove);
      draft.append(row);
    }
  }
  function reset() {
    operation?.abort();
    operation = null;
    uploadController?.abort();
    uploadController = null;
    items = [];
    status.textContent = '';
    render();
  }
  button.addEventListener('click', async () => {
    if (operation) {
      operation.abort();
      operation = null;
      status.textContent = 'Capture cancelled. Close the browser chooser if it is still open.';
      render();
      return;
    }
    if (state.sending || state.preparingAttachments) {
      status.textContent = 'Wait for the current message to finish before capturing.';
      return;
    }
    const controller = new AbortController();
    operation = controller;
    status.textContent = 'Choose a screen, window or tab. One snapshot is added to your draft; audio is off.';
    const pending = captureScreen(controller.signal);
    render();
    try {
      const item = await pending;
      if (operation !== controller) return;
      items.push(item);
      status.textContent = 'Snapshot ready. Sharing stopped. The image uploads when you send your message.';
    } catch (error) {
      if (operation === controller) status.textContent = captureErrorMessage(error);
    } finally {
      if (operation === controller) { operation = null; render(); }
    }
  });
  async function upload() {
    if (operation) throw new Error('Finish or cancel the screen capture before sending.');
    if (!items.length) return [];
    const controller = new AbortController();
    const epoch = state.viewEpoch || 0;
    const active = () => !controller.signal.aborted && (state.viewEpoch || 0) === epoch;
    uploadController = controller;
    render();
    status.textContent = 'Uploading snapshots…';
    try {
      const references = [];
      for (const item of items) {
        if (!item.reference) {
          const response = await fetch('/api/history/attachments', {
            method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ ...item, conversationId: state.conversationId || undefined }), signal: controller.signal
          });
          if (!response.ok) throw await errorFromResponse(response, 'The snapshot upload failed.');
          const { data } = await response.json();
          if (!active()) throw new DOMException('Conversation changed.', 'AbortError');
          if (!attachmentUrl(data?.conversationId, data?.attachment?.id)) throw new Error('The upload returned no attachment receipt.');
          state.conversationId = data.conversationId;
          item.reference = data.attachment;
        }
        if (!references.some(file => file.id === item.reference.id)) references.push(item.reference);
      }
      return references;
    } catch (error) {
      if (active()) status.textContent = 'Upload failed. Your snapshots remain in the draft; send again to retry.';
      throw error;
    } finally {
      if (uploadController === controller) { uploadController = null; render(); }
    }
  }
  const onPageHide = () => reset();
  globalThis.addEventListener('pagehide', onPageHide);
  render();
  return { upload, reset, clearDraft: () => { items = []; status.textContent = ''; render(); },
    destroy: () => { reset(); globalThis.removeEventListener('pagehide', onPageHide); } };
}
