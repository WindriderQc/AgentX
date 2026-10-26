/* Read only the selected card. Form fields and arbitrary DOM text never leave
   an embedded page; Analytics explicitly supplies its Core read reference. */
(function (root) {
  'use strict';
  function observe(card) {
    const block = card._displayBlock;
    const base = { contract: 'agentx.presentation/v1', id: card.dataset.presentationId,
      revision: card.dataset.presentationId, kind: block.kind, title: card.querySelector('.display-block-title')?.textContent || block.title || '', status: 'visible',
      ...(block.partial && { partial: true }) };
    if (block.kind === 'secret') return { ...base, status: 'unavailable' };
    if (block.kind !== 'page') {
      if (block.kind === 'image') {
        const image = card.querySelector('img');
        return { ...base, status: image?.complete && image.naturalWidth > 0 ? 'visible'
          : card.querySelector('.conversation-image')?._presentationState?.()
            || (card.querySelector('.display-block-note') ? 'unavailable' : 'loading'), observation: 'pixels_not_supplied' };
      }
      if (block.kind === 'scene') return { ...base, observation: 'caption_only', text: block.title || '' };
      return { ...base, text: block.body.slice(0, 8000), truncated: block.body.length > 8000 };
    }
    const target = card._screenTarget;
    base.page = root.AgentXScreenPages.canonical(target);
    if (!card._screenFrame) return { ...base, status: 'external' };
    try {
      const doc = card._screenFrame.contentDocument;
      const expected = new URL(root.AgentXScreenPages.url(target), root.location.href);
      if (!doc?.body || doc.location.origin !== root.location.origin || doc.location.pathname !== expected.pathname)
        return { ...base, status: card._screenState?.() || 'loading' };
      const content = card._screenFrame.contentWindow.AgentXPresentedContent;
      const detail = content?.contract === 'agentx.presentation/v1' ? content : null;
      if (target.page === 'ecosystem' && (new URL(doc.location.href).searchParams.get('app') !== 'ecosystem' || !detail))
        return { ...base, status: 'unavailable' };
      return { ...base, status: detail && detail.state !== 'ready' ? detail.state === 'loading' ? 'loading' : 'unavailable' : 'visible',
        title: String(doc.title || base.title).slice(0, 160),
        headings: Array.from(doc.querySelectorAll('h1,h2,h3')).filter(el => el.getClientRects().length)
          .slice(0, 6).map(el => el.textContent.trim().slice(0, 160)),
        ...(detail && { read: detail.read, filters: detail.filters, selection: detail.selection }),
        ...(target.page === 'ecosystem' && detail?.observation && { observation: detail.observation }),
        ...(target.page === 'analytics' && { live: card._screenFrame.contentWindow.AgentXPresentedLiveContent }) };
    } catch { return { ...base, status: 'external' }; }
  }
  root.AgentXPresentationObservation = Object.freeze({ observe });
})(typeof window === 'undefined' ? globalThis : window);
