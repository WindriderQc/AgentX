'use strict';

// The parent journal's view of one child-safe turn (#168): what was asked, what
// Nestor said, and what he put on the child's screen. Screen blocks and the math
// picture's receipt come from the recorded turn; a secret is never retained, so
// only the fact that one was shown appears.
(function exposeJournalDisplay(root) {
  const KIND_LABELS = { text: 'Note', list: 'List', table: 'Table', code: 'Code', link: 'Link', secret: 'Secret', image: 'Image' };
  const PREVIEW_CHARS = 280;
  const SOURCE_LABELS = { web: 'Internet', photos: 'Family photos', media: 'Media share', generated: 'Generated' };
  const REJECTIONS = { 'no-face': '3D unavailable on the device', 'out-of-bounds': 'outside the allowed bounds', unavailable: 'scene unavailable' };

  // The same addresses the child's screen accepts: Core's own visuals routes or https.
  function imageUrl(value) {
    const url = String(value || '');
    if (/^\/api\/voice-personas\/(?:family|private)\/visuals\/(?:file|generated)\?/.test(url)) return url;
    try { return new URL(url).protocol === 'https:' ? url : ''; } catch { return ''; }
  }

  function preview(body) {
    const text = String(body || '').trim();
    return text.length > PREVIEW_CHARS ? text.slice(0, PREVIEW_CHARS) + '…' : text;
  }

  function blockHtml(block, esc) {
    const label = KIND_LABELS[block.kind] || KIND_LABELS.text;
    const title = block.title ? ` · ${esc(block.title)}` : '';
    if (block.kind === 'secret') return `<li><span class="journal-shown-kind">${label}</span>${title} <em>shown masked, not retained</em></li>`;
    if (block.kind === 'image') {
      const source = esc(SOURCE_LABELS[block.source] || block.source || 'unknown source');
      const href = block.status === 'found' ? imageUrl(block.image?.url) : '';
      if (!href) return `<li><span class="journal-shown-kind">${label}</span> <em>no picture found</em> for « ${esc(block.body)} » · ${source}</li>`;
      const origin = imageUrl(block.image?.origin);
      return `<li><span class="journal-shown-kind">${label}</span>${title} · « ${esc(block.body)} » · ${source}`
        + (origin ? ` · <a href="${esc(origin)}" target="_blank" rel="noopener noreferrer">${esc(block.image?.originTitle || 'origin')}</a>` : '')
        + `<img class="journal-shown-image" src="${esc(href)}" alt="${esc(block.title || block.body)}" loading="lazy" referrerpolicy="no-referrer"></li>`;
    }
    return `<li><span class="journal-shown-kind">${label}</span>${title}<div class="journal-shown-body">${esc(preview(block.body))}</div></li>`;
  }

  function sceneHtml(receipt, esc) {
    if (!receipt?.status) return '';
    const picture = receipt.kind === 'add' ? `${receipt.a} + ${receipt.b} = ${receipt.a + receipt.b}`
      : receipt.kind === 'count' ? `counting to ${receipt.to}` : 'scene';
    const outcome = receipt.status === 'applied' ? 'drawn' : `not drawn (${esc(REJECTIONS[receipt.reason] || receipt.reason || 'rejected')})`;
    return `<li><span class="journal-shown-kind">3D</span> ${esc(picture)} · ${outcome}</li>`;
  }

  /** What reached the child's screen for this turn, or '' when nothing did. */
  function shown(row, esc) {
    const blocks = (Array.isArray(row?.display) ? row.display : []).filter(block => block && typeof block.kind === 'string');
    const items = blocks.map(block => blockHtml(block, esc)).join('') + sceneHtml(row?.sceneReceipt, esc);
    if (!items) return '';
    const count = blocks.length + (row?.sceneReceipt?.status ? 1 : 0);
    return `<details class="journal-shown"><summary>Shown on screen · ${count}</summary><ul>${items}</ul></details>`;
  }

  function row(entry, { esc, sound = null }) {
    const flags = Array.isArray(entry.safetyFlags) ? entry.safetyFlags : [];
    const soundNote = entry.soundId ? ` · offered ${esc(sound ? `${sound.emoji} ${sound.label.fr}` : entry.soundId)}` : '';
    return `<div class="audit ${entry.parentAttention || flags.length ? 'danger-box' : ''}"><strong>${esc(entry.inputText || 'No retained preview')}</strong>`
      + `<div>${esc(entry.replyText)}</div>${shown(entry, esc)}`
      + `<small>${esc(new Date(entry.createdAt).toLocaleString())} · ${esc(entry.packId || 'unknown lane')} · ${esc(entry.channel)} · ${esc(entry.model || 'deterministic')} · ${entry.durationMs}ms${soundNote}${flags.length ? ` · ${esc(flags.join(', '))}` : ''}</small></div>`;
  }

  root.JournalDisplay = Object.freeze({ row, shown });
}(typeof window !== 'undefined' ? window : globalThis));
