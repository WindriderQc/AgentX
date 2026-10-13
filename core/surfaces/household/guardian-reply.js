'use strict';
const { unfinishedToolPreamble } = require('./conversation-agent');

// Native guardian text is verified by the agent client before finish(). This
// prefix only selects presentation of an already accepted Main request; it
// grants no tools or permission and never becomes spoken or canonical prose.
const MAIN_REQUIRED = '[[NESTOR_MAIN_REQUIRED]]';
// A model can omit the protocol prefix while promising a later answer. Such a
// short acknowledgment is not completion. Restrict this fallback to the
// guardian's own progress voice, not quoted dialogue in a story or a result.
function awaitingMain(text) {
  const value = String(text || '').trim();
  if (value.length > 600 || /\n\s*\n/.test(value)) return false;
  const progress = /^(?:(?:c['’]est fait|bien s[uû]r|d['’]accord|ok(?:ay)?)[,!.\s]+)?(?:je\s+(?:(?:te|vous)\s+)?(?:reviens|vais\s+(?:v[eé]rifier|regarder|consulter|chercher|demander|transmettre|confier|passer)|demande|confie|passe|transmets|v[eé]rifie|regarde|consulte|cherche)|(?:i(?:['’]ll| will)|let me)\s+(?:get|ask|check|consult|pass|look|verify)|(?:main|le cerveau principal)\s+(?:va|will))\b/i;
  const promised = /\b(?:je\s+(?:te|vous)\s+reviens|i(?:['’]ll| will)\s+(?:get|be)\s+back|(?:main|cerveau principal|boss)\b[^.!?]{0,100}\b(?:r[eé]sultat|r[eé]ponse|calcul|v[eé]rifi|answer|result|calculat)|(?:confie|demande|passe|transmets|ask|pass)\b[^.!?]{0,100}\b(?:main|cerveau principal|boss))\b/i;
  return unfinishedToolPreamble(value) || progress.test(value) && promised.test(value);
}
function createGuardianReply(onDelta = () => {}) {
  let prefix = '', decided = false, trim = false;
  function emit(delta) {
    if (trim) { delta = delta.trimStart(); if (delta) trim = false; }
    if (delta) onDelta(delta);
  }
  function push(delta) {
    if (decided) return emit(delta);
    prefix += delta;
    const candidate = prefix.trimStart();
    if (MAIN_REQUIRED.startsWith(candidate)) return;
    decided = true;
    if (candidate.startsWith(MAIN_REQUIRED)) { trim = true; emit(candidate.slice(MAIN_REQUIRED.length)); }
    else emit(prefix);
    prefix = '';
  }
  function finish(text) {
    const candidate = String(text || '').trimStart();
    const pending = candidate.startsWith(MAIN_REQUIRED);
    if (candidate && MAIN_REQUIRED.startsWith(candidate) && !pending) throw new Error('Incomplete guardian routing prefix');
    if (!decided && prefix) {
      decided = true; trim = pending;
      emit(pending ? prefix.trimStart().slice(MAIN_REQUIRED.length) : prefix);
      prefix = '';
    }
    const spoken = pending ? candidate.slice(MAIN_REQUIRED.length).trimStart() : text;
    if (!spoken?.trim()) throw new Error('The guardian supplied no spoken reply');
    return { text: spoken, disposition: pending || awaitingMain(spoken) ? 'awaiting_main' : 'answered' };
  }
  return { push, finish };
}
module.exports = { MAIN_REQUIRED, createGuardianReply, awaitingMain };
