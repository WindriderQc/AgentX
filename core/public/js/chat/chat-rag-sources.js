/**
 * Chat RAG display: retrieved-source citations and the notice shown when
 * retrieval was requested but the knowledge base was unavailable.
 */

export function buildRagSourceViewer(source, idx, showModal) {
  return () => {
    const title = source.title || source.metadata?.filename || source.source || 'Unknown Source';
    const score = Number.isFinite(source.score) ? ` (${(source.score * 100).toFixed(0)}% match)` : '';
    const body = document.createElement('div');
    const heading = document.createElement('p');
    heading.textContent = `Source: ${title}${score}`;
    body.appendChild(heading);
    if (source.metadata?.filepath) {
      const path = document.createElement('p');
      path.textContent = `Path: ${source.metadata.filepath}`;
      body.appendChild(path);
    }
    const content = document.createElement('pre');
    content.className = 'chat-source-text';
    content.textContent = source.text || source.content || source.excerpt || 'No content available';
    body.appendChild(content);
    showModal(`Source [${idx + 1}]: ${title}`, body);
  };
}

function buildRagUnavailableNotice() {
  const notice = document.createElement('div');
  notice.className = 'rag-unavailable-notice';
  notice.setAttribute('role', 'note');
  notice.style.cssText = 'margin-top:0.75rem;font-size:0.8rem;color:var(--warning, #f59e0b);';
  const icon = document.createElement('i');
  icon.className = 'fas fa-exclamation-triangle';
  icon.style.marginRight = '6px';
  notice.appendChild(icon);
  notice.appendChild(document.createTextNode('Knowledge base unavailable: this answer was generated without your documents.'));
  return notice;
}

export function appendRagDisplay(bubble, message, showModal) {
  if ((message.ragStatus || message.metadata?.ragStatus) === 'unavailable') {
    bubble.appendChild(buildRagUnavailableNotice());
  }
  if (!Array.isArray(message.ragSources) || message.ragSources.length === 0) return;

  const citationsDiv = document.createElement('details');
  citationsDiv.className = 'message-citations';

  const citationsTitle = document.createElement('summary');
  citationsTitle.className = 'citations-title';
  citationsTitle.style.cursor = 'pointer';
  citationsTitle.style.listStyle = 'none';
  citationsTitle.innerHTML = '<i class="fas fa-chevron-right" style="font-size: 0.8em; margin-right: 6px; transition: transform 0.2s;"></i><i class="fas fa-book"></i><span>Sources</span>';
  citationsDiv.appendChild(citationsTitle);

  citationsDiv.addEventListener('toggle', () => {
    const icon = citationsTitle.querySelector('.fa-chevron-right');
    icon.style.transform = citationsDiv.open ? 'rotate(90deg)' : 'rotate(0deg)';
  });

  message.ragSources.forEach((source, idx) => {
    const sourceItem = document.createElement('div');
    sourceItem.className = 'citation-item';
    sourceItem.setAttribute('role', 'button');
    sourceItem.setAttribute('tabindex', '0');
    sourceItem.setAttribute('aria-label', `View source ${idx + 1}: ${source.metadata?.filename || 'Unknown Source'}`);

    const sourceHeader = document.createElement('div');

    const sourceNum = document.createElement('span');
    sourceNum.className = 'citation-number';
    sourceNum.textContent = `[${idx + 1}]`;

    const sourceTitle = document.createElement('span');
    sourceTitle.className = 'citation-title';
    sourceTitle.textContent = source.metadata?.filename || 'Unknown Source';

    const sourceScore = document.createElement('span');
    sourceScore.className = 'citation-score';
    if (source.score) {
      sourceScore.textContent = `${(source.score * 100).toFixed(0)}% match`;
    }

    sourceHeader.appendChild(sourceNum);
    sourceHeader.appendChild(sourceTitle);
    if (source.score) sourceHeader.appendChild(sourceScore);

    if (source.wasCompressed) {
      const compressBadge = document.createElement('span');
      compressBadge.className = 'compression-badge';
      const compressionRatio = Number.isFinite(Number(source.compressionRatio))
        ? Math.max(0, Math.min(100, Number(source.compressionRatio)))
        : 0;
      const compressIcon = document.createElement('i');
      compressIcon.className = 'fas fa-compress-arrows-alt';
      compressBadge.appendChild(compressIcon);
      compressBadge.appendChild(document.createTextNode(` ${compressionRatio}%`));
      compressBadge.title = `Context compressed by ${compressionRatio}%`;
      sourceHeader.appendChild(compressBadge);
    }

    sourceItem.appendChild(sourceHeader);

    if (source.excerpt) {
      const sourceExcerpt = document.createElement('div');
      sourceExcerpt.className = 'citation-excerpt';
      sourceExcerpt.textContent = `"${source.excerpt}${source.excerpt.length >= 200 ? '...' : ''}"`;
      sourceItem.appendChild(sourceExcerpt);
    }

    const viewSource = buildRagSourceViewer(source, idx, showModal);
    sourceItem.addEventListener('click', viewSource);
    sourceItem.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); viewSource(); }
    });

    citationsDiv.appendChild(sourceItem);
  });

  bubble.appendChild(citationsDiv);
}
