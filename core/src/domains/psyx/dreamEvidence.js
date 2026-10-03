'use strict';

const crypto = require('crypto');
const KINDS = new Set(['conversation', 'profile', 'memory', 'experiment', 'checkIn', 'assessment', 'notes', 'tasks', 'mail']);
const plain = value => typeof value === 'string' ? value.trim().normalize('NFC') : '';

function evidenceSource(kind, text, { conversationId = null, messageIndex = null, key = '' } = {}) {
  const content = plain(text);
  const textHash = crypto.createHash('sha256').update(content).digest('hex');
  return { kind, text: content, conversationId, messageIndex, key, textHash };
}

function normalizeEvidenceRefs(value) {
  return (Array.isArray(value) ? value : []).filter(ref => KINDS.has(ref?.kind)
    && typeof ref.quote === 'string' && ref.quote.trim()
    && /^[a-f0-9]{64}$/.test(ref.textHash || '')).slice(0, 4).map(ref => ({
    kind: ref.kind, quote: plain(ref.quote).slice(0, 240), textHash: ref.textHash,
    conversationId: plain(ref.conversationId).slice(0, 80) || null,
    messageIndex: Number.isSafeInteger(ref.messageIndex) && ref.messageIndex >= 0 ? ref.messageIndex : null,
    key: plain(ref.key).slice(0, 80)
  }));
}

// Quotes must occur verbatim in material this exact inference received. A
// reference or hash supplied by the model cannot authorise its own evidence.
function verifyEvidence(value, sources) {
  const evidence = [], evidenceRefs = [];
  for (const supplied of Array.isArray(value) ? value.slice(0, 4) : []) {
    const quote = plain(supplied).replace(/^[«“"]\s*|\s*[»”"]$/g, '').trim();
    if (!quote || quote.length > 240) continue;
    const source = [...sources].reverse().find(item => item.text.includes(quote));
    if (!source) continue;
    evidence.push(quote);
    evidenceRefs.push({ kind: source.kind, quote, textHash: source.textHash,
      conversationId: source.conversationId, messageIndex: source.messageIndex, key: source.key });
  }
  return { evidence, evidenceRefs };
}

function groundDreamEvidence(value, sources) {
  const ground = item => item && typeof item === 'object' ? { ...item, ...verifyEvidence(item.evidence, sources) } : item;
  return { ...value, portrait: { ...value.portrait, sections: (Array.isArray(value.portrait?.sections) ? value.portrait.sections : [])
    .map(section => ({ ...section, statements: (Array.isArray(section?.statements) ? section.statements : []).map(ground) })) },
    findings: (Array.isArray(value.findings) ? value.findings : []).map(ground),
    memory: (Array.isArray(value.memory) ? value.memory : []).map(ground) };
}

module.exports = { evidenceSource, normalizeEvidenceRefs, verifyEvidence, groundDreamEvidence };
