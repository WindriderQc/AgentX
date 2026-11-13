'use strict';

(function expose(root) {
  const source = typeof module !== 'undefined' && module.exports
    ? require('../../../public/js/conversation-written') : root.ConversationWritten;
  function render(row, turn, { language = 'fr' } = {}) {
    if (!source.valid(turn?.written)) return false;
    const previous = row._writtenTurn?.written;
    if (previous && ((previous.revision || 1) > (turn.written.revision || 1)
      || previous.status === 'complete' && turn.written.status !== 'complete' && (previous.revision || 1) >= (turn.written.revision || 1)
      || previous.sourceTurnId && turn.written.sourceTurnId && previous.sourceTurnId !== turn.written.sourceTurnId)) return false;
    const doc = row.ownerDocument, english = language === 'en';
    let view = row.querySelector('.written-reply');
    if (!view) {
      row.replaceChildren();
      view = doc.createElement('details'); view.className = 'written-reply'; view.open = true;
      const title = doc.createElement('summary'); title.textContent = english ? 'Complete answer' : 'Réponse complète';
      const body = doc.createElement('div'); body.className = 'written-reply-body';
      const status = doc.createElement('small'); status.className = 'written-reply-status'; status.setAttribute('role', 'status');
      const copy = doc.createElement('button'); copy.type = 'button'; copy.className = 'button';
      copy.textContent = english ? 'Copy answer' : 'Copier la réponse';
      copy.onclick = async () => {
        try { await root.navigator.clipboard.writeText(source.text(row._writtenTurn)); copy.textContent = english ? 'Copied' : 'Copié'; }
        catch { status.textContent = english ? 'Select the answer to copy it.' : 'Sélectionnez la réponse pour la copier.'; }
      };
      view.append(title, body, status, copy); row.append(view);
    }
    row._writtenTurn = turn;
    view.querySelector('.written-reply-body').textContent = source.text(turn);
    const incomplete = turn.written.status !== 'complete' || source.parts(turn).some(part => part.kind === 'missing');
    view.querySelector('.written-reply-status').textContent = incomplete
      ? english ? 'Partial answer' : 'Réponse partielle'
      : turn.interrupted ? english ? 'Playback interrupted; written answer retained.' : 'Lecture interrompue ; réponse écrite conservée.' : '';
    row.dataset.writtenRevision = String(turn.written.revision || 1);
    return true;
  }
  const api = Object.freeze({ render });
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.WrittenReply = api;
}(typeof window !== 'undefined' ? window : globalThis));
