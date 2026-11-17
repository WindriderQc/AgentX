'use strict';

// A presentation on the existing Core turn. Display bodies have one owner;
// ordered segments reference them instead of copying them into another store.
(function expose(root) {
  function valid(value) {
    return value?.version === 1 && Array.isArray(value.segments)
      && value.segments.every(segment => segment && (segment.kind === 'text'
        ? typeof segment.text === 'string' : segment.kind === 'display' && typeof segment.blockId === 'string'));
  }
  function parts(turn) {
    if (!valid(turn?.written)) return null; // Legacy order was not recorded.
    const blocks = new Map((turn.display || []).map(block => [block.id, block]));
    return turn.written.segments.flatMap(segment => segment.kind === 'text' ? [{ kind: 'text', text: segment.text }]
      : blocks.has(segment.blockId) ? [{ kind: 'display', block: blocks.get(segment.blockId) }] : [{ kind: 'missing', blockId: segment.blockId }]);
  }
  function blockText(block) {
    if (block.kind === 'secret') return '[Secret masqué, non conservé]';
    if (block.kind === 'page') return ''; // Navigation is a command, not answer prose.
    if (block.kind === 'image') return `[Image : ${block.title || block.body || ''}]`;
    const body = String(block.body || '');
    if (block.kind === 'link') return block.title ? `${block.title} (${body})` : body;
    return '\n' + [block.title, body].filter(Boolean).join('\n') + '\n';
  }
  function text(turn) {
    const ordered = parts(turn);
    if (!ordered) return [turn?.replyText || turn?.text || '', ...(turn?.display || []).map(blockText)].filter(Boolean).join('\n\n');
    return ordered.map(part => part.kind === 'text' ? part.text : part.kind === 'missing' ? '[Contenu indisponible]' : blockText(part.block)).join('').trim();
  }
  // Per-response transport state only. Sequence fences make repeated events
  // harmless; a gap stays partial until the canonical terminal snapshot arrives.
  function stream() {
    let sequence = 0, gap = false;
    const segments = [], display = new Map();
    return {
      push(event) {
        if (event.version !== 1 || event.revision !== 1 || !Number.isInteger(event.sequence) || event.sequence <= sequence) return false;
        if (event.sequence !== sequence + 1) { gap = true; return false; }
        const segment = event.segment;
        if (!valid({ version: 1, segments: [segment] })) return false;
        if (segment.kind === 'text' && segments.at(-1)?.kind === 'text') segments.at(-1).text += segment.text;
        else segments.push({ ...segment });
        if (event.block?.id && event.block.id === segment.blockId) display.set(event.block.id, event.block);
        sequence = event.sequence;
        return true;
      },
      snapshot() { return { written: { version: 1, revision: 1, sequence, status: 'partial', gap,
        segments: segments.map(segment => ({ ...segment })) }, display: [...display.values()] }; }
    };
  }
  const api = Object.freeze({ valid, parts, text, blockText, stream });
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.ConversationWritten = api;
}(typeof window !== 'undefined' ? window : globalThis));
