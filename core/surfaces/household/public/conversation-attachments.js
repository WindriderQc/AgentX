/* Personal composer drafts. Captures share attachment ownership, without photo archiving. */
(function (root) {
  'use strict';
  function mount({ el, api, base, busy }) {
    let files = [], generation = 0;
    const captures = new WeakMap();
    function render() {
      const host = el('conversationDraftFiles'); host.replaceChildren();
      files.forEach((file, index) => {
        const row = document.createElement('div'); row.className = 'conversation-attachment';
        const label = document.createElement('span'); label.textContent = file.name;
        const capture = captures.get(file);
        if (capture) {
          const preview = document.createElement('img'); preview.src = capture.dataUrl; preview.alt = 'Screen snapshot draft';
          preview.style.maxWidth = '240px'; preview.style.maxHeight = '160px'; row.append(preview);
        }
        const remove = document.createElement('button'); remove.type = 'button'; remove.className = 'button'; remove.textContent = 'Remove';
        remove.disabled = busy(); remove.setAttribute('aria-label', `Remove ${file.name}`);
        remove.onclick = () => { files.splice(index, 1); render(); };
        row.append(label, remove); host.append(row);
      });
    }
    el('conversationFiles').onchange = event => {
      const selected = Array.from(event.target.files || []);
      if (selected.length + files.length > 3 || !selected.every(NestorAttachmentImages.accepts)) {
        el('conversationStatus').textContent = 'Choose at most 3 files: photos up to 50 MB, documents up to 2 MB.';
      } else { files.push(...selected); render(); }
      event.target.value = '';
    };
    function addCapture(snapshot, request, sessionId) {
      if (busy() || files.length >= 3) throw new Error('Finish the current message or remove a file before adding this snapshot.');
      const file = { name: 'screen-capture.png', type: 'image/png' };
      captures.set(file, { ...snapshot, requestId: request.requestId, sessionId, expiresAt: request.expiresAt });
      files.push(file); render();
      el('conversationFiles').closest('details').open = true;
    }
    async function upload(session, signal) {
      const refs = [], epoch = generation;
      const current = () => { signal?.throwIfAborted(); if (epoch !== generation) throw new DOMException('Conversation changed.', 'AbortError'); };
      for (const original of files) {
        current();
        const capture = captures.get(original), image = NestorAttachmentImages.isImage(original);
        if (capture && (capture.sessionId !== session.sessionId || session.ephemeral)) throw new Error('This snapshot belongs to another conversation. Remove it and request a new capture.');
        if (capture && !capture.reference && Date.parse(capture.expiresAt) <= Date.now()) throw new Error('This capture request expired. Remove the snapshot and ask Nestor for a new capture.');
        const file = capture ? original : image ? await NestorAttachmentImages.reduce(original) : original;
        const types = { txt: 'text/plain', md: 'text/markdown', csv: 'text/csv', json: 'application/json', pdf: 'application/pdf', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg' };
        const mimeType = types[file.name.split('.').at(-1).toLowerCase()] || file.type;
        const dataUrl = capture?.dataUrl || await new Promise((resolve, reject) => {
          const reader = new FileReader(); reader.onload = () => resolve(`data:${mimeType};base64,${String(reader.result).split(',')[1]}`);
          reader.onerror = () => reject(new Error('The file cannot be read.')); reader.readAsDataURL(file);
        });
        current();
        const data = capture?.reference ? { attachment: capture.reference } : await api(`${base}/${encodeURIComponent(session.sessionId)}/attachments`, {
          method: 'POST', signal, body: JSON.stringify({ name: file.name, dataUrl }) });
        current();
        if (capture) {
          capture.reference = data.attachment;
          await api(`${base}/${encodeURIComponent(session.sessionId)}/screen-capture`, { method: 'POST', signal,
            body: JSON.stringify({ requestId: capture.requestId, status: 'attached', attachmentId: data.attachment.id }) });
          current();
        }
        refs.push(data.attachment);
        // Captures never enter the independent photo archive.
        if (image && !capture && !session.ephemeral) await api(`${base}/${encodeURIComponent(session.sessionId)}/attachments/${encodeURIComponent(data.attachment.id)}/original`, {
          method: 'POST', signal, body: original,
          headers: { 'Content-Type': original.type || 'application/octet-stream', 'X-Original-Name': encodeURIComponent(original.name) } })
          .catch(error => { if (signal?.aborted) throw error; console.warn('Original photo not archived', error.message); });
      }
      return refs;
    }
    return { render, upload, addCapture, hasFiles: () => files.length > 0,
      hasCapture: requestId => files.some(file => captures.get(file)?.requestId === requestId),
      removeCapture: requestId => { files = files.filter(file => captures.get(file)?.requestId !== requestId); render(); },
      clear: () => { generation++; files = []; render(); } };
  }
  root.NestorConversationAttachments = { mount };
})(window);
