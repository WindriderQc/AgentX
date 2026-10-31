// gog accepts CSV entries and resolves system label names without case sensitivity.
// Use the same canonical tokens in the approval policy and the actual command.
const SYSTEM = new Set(['INBOX', 'SPAM', 'TRASH', 'UNREAD', 'STARRED', 'IMPORTANT',
  'SENT', 'DRAFT', 'CHAT', 'CATEGORY_PERSONAL', 'CATEGORY_SOCIAL',
  'CATEGORY_PROMOTIONS', 'CATEGORY_UPDATES', 'CATEGORY_FORUMS']);

export function normalizeLabels(values = []) {
  if (!Array.isArray(values)) throw new Error('Labels must be an array');
  return [...new Set(values.flatMap(value => {
    if (typeof value !== 'string' || /["\r\n]/.test(value)) {
      throw new Error('Pass labels as separate unquoted array entries');
    }
    return value.split(',').map(label => {
      const text = label.trim(), upper = text.toUpperCase();
      if (SYSTEM.has(upper)) return upper;
      if (text.toLowerCase() === 'secretary/processed') return 'Secretary/Processed';
      return text;
    }).filter(Boolean);
  }))];
}

export function sensitiveLabels(params) {
  const add = normalizeLabels(params.addLabels), remove = normalizeLabels(params.removeLabels);
  return add.some(label => ['TRASH', 'SPAM', 'Secretary/Processed'].includes(label)
    || /^label_/i.test(label)) || remove.includes('INBOX');
}
