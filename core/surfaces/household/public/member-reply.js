'use strict';

window.followConversationMember = function ({ api, sessionBase, transcript, status, language, getConversation, show }) {
  // The reply of a member whose turn went on in the background (member-work.js on Core).
  return async function followMember(session, turnId, speaker) {
    const conversation = getConversation();
    const name = speaker?.name || session.persona?.name || 'Nestor';
    const url = `${sessionBase}/${encodeURIComponent(session.sessionId)}/member-reply?turn=${encodeURIComponent(turnId)}`;
    const here = () => conversation.session?.sessionId === session.sessionId;
    status.textContent = `${name} is continuing in the background. Its answer will be spoken as soon as it is ready.`;
    for (let round = 0; round < 20 && here(); round += 1) {
      let work;
      try { work = (await api(url))?.work; } catch { return; }
      if (!work || !here()) return;
      if (work.pending) continue;
      transcript.querySelector('.empty')?.remove();
      const row = document.createElement('div');
      if (work.status !== 'answered' || !work.reply?.text) {
        row.className = 'conversation-message activity'; row.textContent = `${name} could not finish its answer.`;
        transcript.append(row); transcript.scrollTop = transcript.scrollHeight;
        return;
      }
      row.className = 'conversation-message assistant'; row.dataset.speaker = name; row.dataset.spoken = 'false';
      row.textContent = work.reply.text; WrittenReply.render(row, work.reply, { language: language.value }); transcript.append(row); transcript.scrollTop = transcript.scrollHeight;
      for (const block of work.reply.display || []) show(block);
      // Said at the first pause; the text is already on screen and in the history.
      for (let attempt = 0; attempt < 90 && here(); attempt += 1) {
        const completed = await conversation.interject(work.reply, { preserveLanguage: true, onScheduled() { row.dataset.spoken = 'true'; } });
        if (completed || row.dataset.spoken === 'true') return;
        await new Promise(resolve => setTimeout(resolve, 2000));
      }
      return;
    }
  };
};
