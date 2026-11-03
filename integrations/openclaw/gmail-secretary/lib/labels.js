// gog accepts CSV entries and resolves system label names without case sensitivity.
// Use the same canonical tokens in the approval policy and the actual command.
const SYSTEM = new Map(['INBOX', 'SPAM', 'TRASH', 'UNREAD', 'STARRED', 'IMPORTANT',
  'SENT', 'DRAFT', 'CHAT', 'CATEGORY_PERSONAL', 'CATEGORY_SOCIAL',
  'CATEGORY_PROMOTIONS', 'CATEGORY_UPDATES', 'CATEGORY_FORUMS'].map(label => [label.toLowerCase(), label]));

export function normalizeLabels(values = []) {
  if (!Array.isArray(values)) throw new Error('Labels must be an array');
  return [...new Set(values.flatMap(value => {
    if (typeof value !== 'string') throw new Error('Labels must be strings');
    return value.split(',').map(label => {
      // Go's strings.TrimSpace also removes U+0085, which JS trim leaves
      // intact. Canonicalize before both policy and CLI dispatch.
      const text = label.replace(/^[\p{White_Space}\uFEFF]+|[\p{White_Space}\uFEFF]+$/gu, '');
      // Go uses simple lowercase: U+0130 becomes ASCII i, whereas JS's full
      // lowercase produces i + combining dot. Match native protected names.
      const key = text.replace(/\u0130/g, 'i').toLowerCase();
      if (SYSTEM.has(key)) return SYSTEM.get(key);
      if (key === 'secretary/processed') return 'Secretary/Processed';
      return text;
    }).filter(Boolean);
  }))];
}

export function sensitiveLabels(params) {
  const { add, remove } = protectedLabelChanges(params);
  return add.length > 0 || remove.length > 0;
}

export function protectedLabelChanges(params) {
  return {
    add: normalizeLabels(params.addLabels).filter(label => ['TRASH', 'SPAM', 'Secretary/Processed'].includes(label)
      || /^label_/i.test(label)),
    remove: normalizeLabels(params.removeLabels).filter(label => label === 'INBOX'),
  };
}

export function displayLabels(values) {
  return JSON.stringify(values).replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu,
    char => `\\u{${char.codePointAt(0).toString(16)}}`);
}
