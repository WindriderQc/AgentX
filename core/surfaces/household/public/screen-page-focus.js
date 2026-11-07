/* Page-owned anchors only. Display changes never click a control or interpret
   a selector supplied by a model or restored conversation. */
(function (root) {
  'use strict';
  let revision = 0;
  function apply(card) {
    const pages = root.AgentXScreenPages, target = card?._screenTarget;
    const section = target?.focus?.section;
    const anchor = pages?.SECTIONS?.[target?.page]?.[section];
    if (!anchor || !card._screenFrame) return null;
    const unavailable = { section, status: 'unavailable' };
    try {
      const doc = card._screenFrame.contentDocument;
      const expected = new URL(pages.url(target), root.location.href);
      if (!doc?.body || expected.origin !== root.location.origin || doc.location.origin !== expected.origin
        || doc.location.pathname !== expected.pathname || new URL(doc.location.href).searchParams.get('view') !== 'screen') return unavailable;
      const node = doc.getElementById(anchor);
      if (!node || node.hidden || !node.getClientRects().length) return unavailable;
      let style = doc.getElementById('agentx-section-focus-style');
      if (!style) {
        style = doc.createElement('style'); style.id = 'agentx-section-focus-style';
        style.textContent = '.agentx-section-focus{outline:3px solid #74d9f0!important;outline-offset:5px;scroll-margin:16px}';
        doc.head.append(style);
      }
      doc.querySelectorAll('.agentx-section-focus').forEach(item => item.classList.remove('agentx-section-focus'));
      node.classList.add('agentx-section-focus');
      node.scrollIntoView({ block: 'center', behavior: 'instant' });
      return { section, status: 'applied', heading: String(node.querySelector('h1,h2,h3')?.textContent || node.textContent || '').trim().slice(0, 160) };
    } catch { return unavailable; }
  }
  function bind(card) {
    card._screenFrame.addEventListener('load', () => {
      const focus = () => { if (card.dataset.selected === 'true') apply(card); };
      try {
        const child = card._screenFrame.contentWindow;
        if (['profiler', 'cluster-schedule'].includes(card._screenTarget?.page)
          && child.AgentXPresentedContent?.state === 'loading') {
          // Data arriving after load can move the anchor. Wait for this
          // initial read, and never scroll an older, unselected card.
          child.addEventListener('agentx-screen-read', focus, { once: true });
        } else focus();
      } catch { /* An unavailable frame has no focus capability. */ }
    });
  }
  function observe(card) {
    const target = card?._screenTarget, section = target?.focus?.section;
    const anchor = root.AgentXScreenPages?.SECTIONS?.[target?.page]?.[section];
    if (!anchor) return null;
    try {
      const node = card._screenFrame?.contentDocument?.getElementById(anchor);
      if (node?.classList.contains('agentx-section-focus') && node.getClientRects().length) {
        return { section, status: 'applied', heading: String(node.querySelector('h1,h2,h3')?.textContent || node.textContent || '').trim().slice(0, 160) };
      }
    } catch { /* The selected frame no longer supplies this section. */ }
    return { section, status: 'unavailable' };
  }
  function present(card, block) {
    const pages = root.AgentXScreenPages, target = pages?.parse(block?.body);
    if (!target?.focus.section || target.page !== card?._screenTarget?.page) return false;
    const withoutSection = value => ({ page: value.page,
      focus: Object.fromEntries(Object.entries(value.focus).filter(([key]) => key !== 'section')) });
    if (pages.url(withoutSection(target)) !== pages.url(withoutSection(card._screenTarget))) return false;
    const previous = card._screenTarget;
    card._screenTarget = target;
    if (apply(card)?.status !== 'applied') { card._screenTarget = previous; return false; }
    card._displayBlock = block;
    card.dataset.presentationRevision = root.crypto?.randomUUID?.() || 'focus-' + Date.now().toString(36) + '-' + (++revision);
    const title = card.querySelector('.display-block-title');
    if (title) title.textContent = block.title || pages.label(target);
    const open = card.querySelector('a.display-block-action');
    if (open) open.href = pages.url(target, { screen: false });
    return true;
  }
  root.AgentXScreenPageFocus = Object.freeze({ apply, observe, present, bind });
})(typeof window === 'undefined' ? globalThis : window);
