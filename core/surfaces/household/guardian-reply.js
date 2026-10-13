'use strict';

// Native guardian text is verified by the agent client before finish(). This
// prefix only selects presentation of an already accepted Main request; it
// grants no tools or permission and never becomes spoken or canonical prose.
const MAIN_REQUIRED = '[[NESTOR_MAIN_REQUIRED]]';
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
    return { text: spoken, disposition: pending ? 'awaiting_main' : 'answered' };
  }
  return { push, finish };
}
module.exports = { MAIN_REQUIRED, createGuardianReply };
