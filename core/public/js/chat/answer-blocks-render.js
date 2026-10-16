import { normalizeEnvelope, tableFallback, isCompleteFallback } from '/dist/answer-blocks.js';

// Build the enhancement off-screen. A rejected/unsupported block never removes
// the already rendered complete text. All table data goes through textContent.
export function enhanceAnswerBlocks(body, message, { renderProse } = {}) {
  if (message?.role !== 'assistant' || !message.answerBlocks) return false;
  try {
    const envelope = normalizeEnvelope(message.answerBlocks);
    if (!isCompleteFallback(message.content, envelope)) return false;
    const doc = body.ownerDocument;
    const node = (tag, className, text) => {
      const element = doc.createElement(tag);
      if (className) element.className = className;
      if (text !== undefined) element.textContent = text;
      return element;
    };
    const enhanced = node('div', 'answer-blocks');
    const prose = message.content.slice(0, -tableFallback(envelope).length).trimEnd();
    if (prose) {
      const narrative = node('div', 'answer-block-narrative');
      if (renderProse) renderProse(narrative, prose); else narrative.textContent = prose;
      enhanced.append(narrative);
    }
    for (const block of envelope.blocks) {
      const wrapper = node('div', 'answer-block-table-wrap');
      wrapper.tabIndex = 0; wrapper.setAttribute('role', 'region'); wrapper.setAttribute('aria-label', block.title);
      const table = node('table', 'answer-block-table');
      table.append(node('caption', '', block.title));
      const head = node('thead'), headings = node('tr');
      block.columns.forEach(label => { const cell = node('th', '', label); cell.scope = 'col'; headings.append(cell); });
      head.append(headings);
      const rows = node('tbody');
      for (const values of block.rows) { const row = node('tr'); values.forEach(text => row.append(node('td', '', text))); rows.append(row); }
      if (!block.rows.length) { const row = node('tr'), empty = node('td', '', 'No rows'); empty.colSpan = block.columns.length; row.append(empty); rows.append(row); }
      table.append(head, rows); wrapper.append(table); enhanced.append(wrapper);
    }
    const version = node('details', 'answer-block-text-version');
    version.append(node('summary', '', 'Text version'), node('pre', 'answer-block-fallback', message.content));
    enhanced.append(version);
    body.replaceChildren(enhanced);
    return true;
  } catch { return false; }
}
