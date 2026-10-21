/**
 * Council handoff link: `/council?question=…&source=playground` pre-fills the
 * form, `/council?id=…` opens one Council (the Telegram relay sends it). The
 * page reads the link once, then removes these parameters from the address so
 * a reload or a shared link does not replay the handoff.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.AgentXCouncilHandoff = api;
}(typeof window !== 'undefined' ? window : null, () => {
  // The server refuses a longer question when the Council is convened.
  const MAX_QUESTION_LENGTH = 5000;
  const HANDOFF_PARAMS = ['question', 'source', 'id'];

  function readCouncilHandoff(search) {
    const params = new URLSearchParams(search || '');
    const raw = params.get('question') || '';
    const question = raw.trim() ? raw.slice(0, MAX_QUESTION_LENGTH) : '';
    const rawId = params.get('id') || '';
    const id = /^[a-f0-9]{24}$/i.test(rawId) ? rawId : null;
    const source = question ? (params.get('source') === 'playground' ? 'playground' : 'link') : null;
    const present = HANDOFF_PARAMS.some((key) => params.has(key));
    HANDOFF_PARAMS.forEach((key) => params.delete(key));
    const rest = params.toString();
    return {
      question,
      truncated: raw.length > MAX_QUESTION_LENGTH,
      source,
      id,
      present,
      cleanSearch: rest ? `?${rest}` : ''
    };
  }

  function handoffMessage(handoff) {
    if (!handoff?.question) return '';
    const from = handoff.source === 'playground' ? 'the Playground' : 'a link';
    const cut = handoff.truncated ? ` It was cut to ${MAX_QUESTION_LENGTH} characters.` : '';
    return `Question handed off from ${from} — nothing has been convened yet.${cut} Review the panel, then Convene Council.`;
  }

  return { MAX_QUESTION_LENGTH, readCouncilHandoff, handoffMessage };
}));
