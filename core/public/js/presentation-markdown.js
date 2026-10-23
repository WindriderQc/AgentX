/* Presentation uses Core's pinned Markdown and sanitizer, with no active HTML,
   remote images or form fields. The original text remains the copy source. */
(function (root) {
  'use strict';
  function render(container, text, { links = true } = {}) {
    if (!root.marked || !root.DOMPurify) { container.textContent = text; return container; }
    const tags = ['p', 'br', 'strong', 'em', 'del', 'code', 'pre', 'blockquote', 'h1', 'h2', 'h3', 'h4',
      'ul', 'ol', 'li', 'table', 'thead', 'tbody', 'tr', 'th', 'td', 'hr', ...(links ? ['a'] : [])];
    container.innerHTML = root.DOMPurify.sanitize(root.marked.parse(text), {
      ALLOWED_TAGS: tags, ALLOWED_ATTR: ['href', 'title', 'start'], ALLOW_DATA_ATTR: false
    });
    container.querySelectorAll('a').forEach(link => {
      if (!/^https?:\/\//i.test(link.getAttribute('href') || '')) link.removeAttribute('href');
      else { link.target = '_blank'; link.rel = 'noopener noreferrer'; }
    });
    return container;
  }
  root.AgentXPresentationMarkdown = Object.freeze({ render });
})(typeof window === 'undefined' ? globalThis : window);
