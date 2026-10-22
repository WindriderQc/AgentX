'use strict';

// "On screen": what Nestor shows rather than says (#167). Blocks arrive from
// the reply stream as `show` events, or with a restored turn. Nothing here is
// ever handed to speech. A secret is masked until explicitly revealed and is
// only available live; a restored one says it was not retained.
(function exposeDisplayBoard(root) {
  const MAX_BLOCKS = 30;
  const KIND_LABELS = { text: 'Note', list: 'List', table: 'Table', code: 'Code', link: 'Link', secret: 'Secret', image: 'Image', scene: '3D', page: 'Page' };
  const STAGE_WAIT_MS = 4000;

  function node(tag, className, text) {
    const element = document.createElement(tag);
    if (className) element.className = className;
    if (text !== undefined) element.textContent = text;
    return element;
  }

  // Models write **bold** even on screen: show it as emphasis, never as asterisks.
  function inlineText(parent, value) {
    String(value).split(/\*\*([^*\n]+)\*\*/).forEach((part, index) => {
      if (!part) return;
      if (index % 2) parent.append(node('strong', '', part));
      else parent.append(document.createTextNode ? document.createTextNode(part) : node('span', '', part));
    });
    return parent;
  }

  function safeUrl(value) {
    if (/^\/images\?operation=[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(String(value || ''))) return value;
    try {
      const url = new URL(/^www\./i.test(value) ? 'https://' + value : value);
      return ['http:', 'https:'].includes(url.protocol) ? url.href : '';
    } catch { return ''; }
  }

  function tableBody(body) {
    const rows = body.split('\n').map(row => row.trim()).filter(row => row.startsWith('|'))
      .filter(row => !/^\|[\s:|-]+\|?$/.test(row))
      .map(row => row.replace(/^\||\|$/g, '').split('|').map(cell => cell.trim()));
    if (!rows.length) return node('pre', 'display-block-text', body);
    const wrap = node('div', 'display-block-table');
    const table = node('table');
    rows.forEach((cells, index) => {
      const tr = node('tr');
      cells.forEach(cell => tr.append(node(index === 0 ? 'th' : 'td', '', cell)));
      table.append(tr);
    });
    wrap.append(table);
    return wrap;
  }

  // External links stay plain text in Famille unless the household turned
  // them on next to "Hey Nestor" in the voice workshop (owner decision).
  const FAMILY_LINKS_KEY = 'household.space.family.links';
  function linksClickable(space) {
    if (space !== 'family') return true;
    try { return root.localStorage?.getItem(FAMILY_LINKS_KEY) === 'clickable'; } catch { return false; }
  }

  function linkBody(body, space) {
    const list = node('div', 'display-block-links');
    const clickable = linksClickable(space);
    body.split(/\s+/).filter(Boolean).forEach(value => {
      const href = safeUrl(value);
      if (!href || !clickable) { list.append(node('span', '', value)); return; }
      const link = node('a', '', value);
      link.href = href; link.target = '_blank'; link.rel = 'noopener noreferrer';
      list.append(link);
    });
    return list;
  }

  function copyButton(text) {
    const button = node('button', 'display-block-action', 'Copy');
    button.type = 'button';
    button.addEventListener('click', async () => {
      try { await navigator.clipboard.writeText(text); button.textContent = 'Copied'; }
      catch { button.textContent = 'Copy failed'; }
      setTimeout(() => { button.textContent = 'Copy'; }, 1500);
    });
    return button;
  }

  function secretBody(block, actions) {
    if (block.redacted || !block.body) return node('p', 'display-block-note', 'Shown once, masked, and not kept.');
    const value = node('code', 'display-block-secret', '•'.repeat(12));
    value.dataset.masked = 'true';
    const reveal = node('button', 'display-block-action', 'Show');
    reveal.type = 'button';
    reveal.addEventListener('click', () => {
      const masked = value.dataset.masked === 'true';
      value.textContent = masked ? block.body : '•'.repeat(12);
      value.dataset.masked = String(!masked);
      reveal.textContent = masked ? 'Hide' : 'Show';
    });
    actions.append(reveal, copyButton(block.body));
    return value;
  }

  // A picture Core found; the model never supplied its address. Web images load
  // directly over https without a referrer, household files through Core.
  function imageBody(block, space) {
    if (block.source === 'local' && root.ConversationImages) return root.ConversationImages.create(block, { space });
    const image = block.status === 'found' ? block.image : null;
    const href = image && (/^\/api\/voice-personas\/(?:family|private)\/visuals\/(?:file|generated)\?/.test(image.url) ? image.url : safeUrl(image.url));
    if (!href) return node('p', 'display-block-note', 'No image found for “' + block.body + '”.');
    const figure = node('figure', 'display-block-figure');
    const img = node('img');
    img.src = href; img.alt = block.title || block.body; img.loading = 'lazy'; img.decoding = 'async'; img.referrerPolicy = 'no-referrer';
    img.addEventListener('error', () => figure.replaceChildren(node('p', 'display-block-note', 'This image is no longer available.')), { once: true });
    const caption = node('figcaption', 'display-block-caption');
    caption.append(node('span', '', image.sourceLabel || block.source || ''));
    const origin = safeUrl(image.origin);
    if (origin && linksClickable(space)) {
      const link = node('a', '', image.originTitle || 'Source');
      link.href = origin; link.target = '_blank'; link.rel = 'noopener noreferrer';
      caption.append(link);
    } else if (image.originTitle) caption.append(node('span', '', image.originTitle));
    figure.append(img, caption);
    return figure;
  }

  // A math picture (#131) drawn by GraphysX's <llmx-stage>, relayed with the avatar module.
  // Its receipt goes back to the avatar dock, which records it on the family turn; without
  // the 3D element the caption stays as the picture, and that is recorded too.
  function sceneBody(block, space) {
    const holder = node('div', 'display-block-stage');
    const caption = node('p', 'display-block-stage-caption', block.title || '');
    holder.append(caption);
    const receipt = value => root.dispatchEvent(new CustomEvent('persona-scene-receipt', { detail: { space, receipt: value } }));
    const registry = root.customElements;
    const ready = registry?.get('llmx-stage') ? Promise.resolve(true)
      : registry ? Promise.race([registry.whenDefined('llmx-stage').then(() => true), new Promise(resolve => setTimeout(() => resolve(false), STAGE_WAIT_MS))])
        : Promise.resolve(false);
    ready.then(defined => {
      if (!defined) { receipt({ status: 'rejected', reason: 'no-face' }); return; }
      const stage = document.createElement('llmx-stage');
      stage.addEventListener('llmx-scene-applied', () => receipt({ status: 'applied' }), { once: true });
      stage.addEventListener('llmx-scene-rejected', event => receipt({ status: 'rejected',
        reason: event.detail?.reason === 'out-of-bounds' ? 'out-of-bounds' : 'unavailable' }), { once: true });
      stage.addEventListener('llmx-stage-error', () => { stage.remove(); holder.classList.remove('has-stage'); receipt({ status: 'rejected', reason: 'no-face' }); }, { once: true });
      stage.scene = block.scene;
      holder.classList.add('has-stage');
      holder.prepend(stage);
    });
    return holder;
  }

  // A live Core page (#924), personal space only. The address is rebuilt from
  // the page name and focus, never taken from the model or a stored turn.
  function pageTarget(block, space) {
    const pages = root.AgentXScreenPages;
    return space === 'personal' && pages ? pages.parse(block.body) : null;
  }

  function pageBody(block, target, actions) {
    const pages = root.AgentXScreenPages;
    const href = pages.url(target);
    const holder = node('div', 'display-page-holder');
    const open = node('a', 'display-block-action', 'Ouvrir dans un onglet');
    open.href = pages.url(target, { screen: false });
    open.target = '_blank'; open.rel = 'noopener noreferrer';
    open.addEventListener('click', () => pages.keepsConversation(target) && root.dispatchEvent(new CustomEvent('nestor-guided-visit', {
      detail: { page: target.page, label: pages.label(target) }
    })));
    actions.append(open);
    const status = node('p', 'display-block-note');
    status.setAttribute('role', 'status');
    holder.append(status);
    if (pages.mode(target) !== 'frame') {
      status.textContent = 'Ouvrez ce service dans un onglet. Nestor reste disponible ici; il ne voit pas le contenu de cet onglet.';
      return holder;
    }
    status.textContent = 'Ouverture de la page… Si elle reste vide ou demande une connexion, utilisez « Ouvrir dans un onglet ».';
    const frame = node('iframe', 'display-block-page');
    frame.src = href; frame.title = block.title || pages.label(target); frame.loading = 'lazy';
    frame.referrerPolicy = 'no-referrer';
    if (!href.startsWith('/')) frame.setAttribute('sandbox', 'allow-scripts allow-same-origin allow-forms allow-popups');
    frame.addEventListener('load', () => {
      // A cross-origin load event does not prove successful service rendering.
      try {
        const doc = frame.contentDocument;
        status.textContent = doc?.body && doc.location.href !== 'about:blank'
          ? 'Page ouverte à côté de la conversation.'
          : 'Le service contrôle son affichage intégré. Si la page reste vide, ouvrez-la dans un onglet.';
      } catch { status.textContent = 'Le service contrôle son affichage intégré. Si la page reste vide, ouvrez-la dans un onglet.'; }
    });
    frame.addEventListener('error', () => { status.textContent = 'Affichage intégré indisponible. Ouvrez le service dans un onglet.'; });
    const expand = node('button', 'display-block-action', 'Agrandir');
    expand.type = 'button';
    expand.addEventListener('click', () => {
      const expanded = frame.classList.contains('is-expanded');
      if (expanded) frame.classList.remove('is-expanded'); else frame.classList.add('is-expanded');
      expand.textContent = expanded ? 'Agrandir' : 'Réduire';
    });
    actions.append(expand);
    holder.append(frame);
    holder._screenFrame = frame;
    holder._screenTarget = target;
    holder._dispose = () => { frame.src = 'about:blank'; };
    return holder;
  }

  function render(block, { secrets, space = 'personal' }) {
    if (!block || (block.kind === 'scene' ? !block.scene : typeof block.body !== 'string') || (block.kind === 'secret' && !secrets)) return null;
    const target = block.kind === 'page' ? pageTarget(block, space) : null;
    if (block.kind === 'page' && !target) return null;
    const card = node('article', 'display-block');
    card.dataset.kind = block.kind;
    const header = node('header', 'display-block-header');
    header.append(node('span', 'display-block-kind', KIND_LABELS[block.kind] || KIND_LABELS.text));
    if (block.title) header.append(node('strong', 'display-block-title', block.title));
    const actions = node('div', 'display-block-actions');
    header.append(actions);
    let content;
    if (block.kind === 'secret') content = secretBody(block, actions);
    else if (block.kind === 'image') content = imageBody(block, space);
    else if (block.kind === 'scene') content = sceneBody(block, space);
    else if (block.kind === 'page') content = pageBody(block, target, actions);
    else {
      if (block.kind === 'table') content = tableBody(block.body);
      else if (block.kind === 'link') content = linkBody(block.body, space);
      else if (block.kind === 'code') { content = node('pre', 'display-block-code'); content.append(node('code', '', block.body)); }
      else content = inlineText(node('div', 'display-block-text'), block.body);
      actions.append(copyButton(block.body));
    }
    card.append(header, content);
    card._dispose = content._dispose;
    card._screenFrame = content._screenFrame;
    card._screenTarget = block.kind === 'page' ? target : null;
    return card;
  }

  function create(container, { secrets = false, kinds = null, heading = 'On screen', space = 'personal' } = {}) {
    const list = node('div', 'display-board-list');
    container.replaceChildren(node('h2', 'display-board-heading', heading), list);
    const update = () => { container.hidden = !list.childElementCount; };
    const board = {
      add(block) {
        if (kinds && !kinds.includes(block?.kind)) return false;
        const card = render(block, { secrets, space });
        if (!card) return false;
        // A keyed block replaces its previous card: one live 3D picture, not one per turn.
        // A page keeps one live frame per page name, refocused by the newest block.
        const key = block.key || (block.operation?.id ? `image:${block.operation.id}`
          : block.kind === 'page' ? `page:${String(block.body).split(/\s+/)[0]}` : '');
        if (key) {
          card.dataset.key = key;
          Array.from(list.children).filter(child => child.dataset?.key === key).forEach(child => { child._dispose?.(); child.remove(); });
        }
        list.prepend(card);
        while (list.childElementCount > MAX_BLOCKS) { list.lastElementChild._dispose?.(); list.lastElementChild.remove(); }
        update();
        return true;
      },
      restore(blocks = []) { (Array.isArray(blocks) ? blocks : []).forEach(board.add); },
      has: key => Array.from(list.children).some(child => child.dataset?.key === key),
      context() {
        return Array.from(list.children).filter(card => card._screenTarget).slice(0, 3).map(card => {
          const target = card._screenTarget, base = { page: target.page, status: 'unavailable' };
          if (!card._screenFrame) return { ...base, status: 'external' };
          try {
            const doc = card._screenFrame.contentDocument;
            const expected = new URL(root.AgentXScreenPages.url(target), root.location.href);
            if (!doc?.body || doc.location.origin !== root.location.origin || doc.location.pathname !== expected.pathname) return base;
            return { ...base, status: 'visible', title: String(doc.title || '').slice(0, 160),
              headings: Array.from(doc.querySelectorAll('h1,h2,h3')).filter(el => el.getClientRects().length)
                .slice(0, 6).map(el => el.textContent.trim().slice(0, 160)) };
          } catch { return { ...base, status: 'external' }; }
        });
      },
      clear() { Array.from(list.children).forEach(child => child._dispose?.()); list.replaceChildren(); update(); }
    };
    update();
    return board;
  }

  // Pages and pictures get the visual zone; everything else goes to the text zone.
  function createScreen({ text, visual }, { secrets = false, space = 'personal' } = {}) {
    const boards = [create(text, { secrets, space, kinds: ['text', 'list', 'table', 'code', 'link', 'secret'] }),
      create(visual, { secrets, space, kinds: ['page', 'image', 'scene'], heading: 'Pages and images' })];
    return {
      // True when one of the zones drew the block.
      add: block => boards.map(board => board.add(block)).some(Boolean),
      restore: blocks => boards.forEach(board => board.restore(blocks)),
      has: key => boards.some(board => board.has(key)),
      context: () => boards.flatMap(board => board.context()).slice(0, 3),
      clear: () => boards.forEach(board => board.clear())
    };
  }

  root.DisplayBoard = Object.freeze({ create, createScreen, render, safeUrl });
}(typeof window !== 'undefined' ? window : globalThis));
