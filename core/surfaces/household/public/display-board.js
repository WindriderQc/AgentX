'use strict';

// "À l'écran": what Nestor shows rather than says (#167). Blocks arrive from
// the reply stream as `show` events, or with a restored turn. Nothing here is
// ever handed to speech. A secret is masked until explicitly revealed and is
// only available live; a restored one says it was not retained.
(function exposeDisplayBoard(root) {
  const MAX_BLOCKS = 30;
  const KIND_LABELS = { text: 'Note', list: 'Liste', table: 'Tableau', code: 'Code', link: 'Lien', secret: 'Secret', image: 'Image', scene: '3D' };
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

  function linkBody(body) {
    const list = node('div', 'display-block-links');
    body.split(/\s+/).filter(Boolean).forEach(value => {
      const href = safeUrl(value);
      if (!href) { list.append(node('span', '', value)); return; }
      const link = node('a', '', value);
      link.href = href; link.target = '_blank'; link.rel = 'noopener noreferrer';
      list.append(link);
    });
    return list;
  }

  function copyButton(text) {
    const button = node('button', 'display-block-action', 'Copier');
    button.type = 'button';
    button.addEventListener('click', async () => {
      try { await navigator.clipboard.writeText(text); button.textContent = 'Copié'; }
      catch { button.textContent = 'Copie impossible'; }
      setTimeout(() => { button.textContent = 'Copier'; }, 1500);
    });
    return button;
  }

  function secretBody(block, actions) {
    if (block.redacted || !block.body) return node('p', 'display-block-note', 'Affiché une seule fois, masqué, et non conservé.');
    const value = node('code', 'display-block-secret', '•'.repeat(12));
    value.dataset.masked = 'true';
    const reveal = node('button', 'display-block-action', 'Afficher');
    reveal.type = 'button';
    reveal.addEventListener('click', () => {
      const masked = value.dataset.masked === 'true';
      value.textContent = masked ? block.body : '•'.repeat(12);
      value.dataset.masked = String(!masked);
      reveal.textContent = masked ? 'Masquer' : 'Afficher';
    });
    actions.append(reveal, copyButton(block.body));
    return value;
  }

  // A picture Core found; the model never supplied its address. Web images load
  // directly over https without a referrer, household files through Core.
  function imageBody(block) {
    const image = block.status === 'found' ? block.image : null;
    const href = image && (/^\/api\/voice-personas\/(?:family|private)\/visuals\/(?:file|generated)\?/.test(image.url) ? image.url : safeUrl(image.url));
    if (!href) return node('p', 'display-block-note', 'Aucune image trouvée pour « ' + block.body + ' ».');
    const figure = node('figure', 'display-block-figure');
    const img = node('img');
    img.src = href; img.alt = block.title || block.body; img.loading = 'lazy'; img.decoding = 'async'; img.referrerPolicy = 'no-referrer';
    img.addEventListener('error', () => figure.replaceChildren(node('p', 'display-block-note', 'Cette image n’est plus disponible.')), { once: true });
    const caption = node('figcaption', 'display-block-caption');
    caption.append(node('span', '', image.sourceLabel || block.source || ''));
    const origin = safeUrl(image.origin);
    if (origin) {
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

  function render(block, { secrets, space = 'personal' }) {
    if (!block || (block.kind === 'scene' ? !block.scene : typeof block.body !== 'string') || (block.kind === 'secret' && !secrets)) return null;
    const card = node('article', 'display-block');
    card.dataset.kind = block.kind;
    const header = node('header', 'display-block-header');
    header.append(node('span', 'display-block-kind', KIND_LABELS[block.kind] || KIND_LABELS.text));
    if (block.title) header.append(node('strong', 'display-block-title', block.title));
    const actions = node('div', 'display-block-actions');
    header.append(actions);
    let content;
    if (block.kind === 'secret') content = secretBody(block, actions);
    else if (block.kind === 'image') content = imageBody(block);
    else if (block.kind === 'scene') content = sceneBody(block, space);
    else {
      if (block.kind === 'table') content = tableBody(block.body);
      else if (block.kind === 'link') content = linkBody(block.body);
      else if (block.kind === 'code') { content = node('pre', 'display-block-code'); content.append(node('code', '', block.body)); }
      else content = inlineText(node('div', 'display-block-text'), block.body);
      actions.append(copyButton(block.body));
    }
    card.append(header, content);
    return card;
  }

  function create(container, { secrets = false, kinds = null, heading = 'À l’écran', space = 'personal' } = {}) {
    const list = node('div', 'display-board-list');
    container.replaceChildren(node('h2', 'display-board-heading', heading), list);
    const update = () => { container.hidden = !list.childElementCount; };
    const board = {
      add(block) {
        if (kinds && !kinds.includes(block?.kind)) return;
        const card = render(block, { secrets, space });
        if (!card) return;
        // A keyed block replaces its previous card: one live 3D picture, not one per turn.
        if (block.key) {
          card.dataset.key = block.key;
          Array.from(list.children).filter(child => child.dataset?.key === block.key).forEach(child => child.remove());
        }
        list.prepend(card);
        while (list.childElementCount > MAX_BLOCKS) list.lastElementChild.remove();
        update();
      },
      restore(blocks = []) { (Array.isArray(blocks) ? blocks : []).forEach(board.add); },
      clear() { list.replaceChildren(); update(); }
    };
    update();
    return board;
  }

  // Pictures get their own zone; everything else goes to the text zone.
  function createScreen({ text, visual }, { secrets = false, space = 'personal' } = {}) {
    const boards = [create(text, { secrets, space, kinds: ['text', 'list', 'table', 'code', 'link', 'secret'] }),
      create(visual, { secrets, space, kinds: ['image', 'scene'], heading: 'Images' })];
    return {
      add: block => boards.forEach(board => board.add(block)),
      restore: blocks => boards.forEach(board => board.restore(blocks)),
      clear: () => boards.forEach(board => board.clear())
    };
  }

  root.DisplayBoard = Object.freeze({ create, createScreen, render, safeUrl });
}(typeof window !== 'undefined' ? window : globalThis));
