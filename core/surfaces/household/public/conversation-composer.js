/* Help people start a conversation without sending or replacing their draft. */
(function () {
  'use strict';
  const prompts = {
    personal: [['My day', 'Help me organize my day from my tasks.'], ['A task', 'Help me clarify a task before adding it to my list.'], ['Think it through', 'Help me think through a decision, one question at a time.']],
    family: [['Understand', 'Explain something to me with a simple example.'], ['Practice', 'Help me practice, one question at a time.'], ['A small step', 'Help me start a safe task, one small step at a time.']]
  };
  function mount({ input, form, family }) {
    const host = document.createElement('div'); host.className = 'conversation-composer-help';
    const starters = document.createElement('div'); starters.className = 'conversation-starters';
    starters.setAttribute('role', 'group'); starters.setAttribute('aria-label', 'Ideas to get started');
    for (const [label, text] of prompts[family ? 'family' : 'personal']) {
      const button = document.createElement('button'); button.type = 'button'; button.textContent = label;
      button.onclick = () => { if (input.value.trim()) return; input.value = text; input.dispatchEvent(new Event('input')); input.focus(); };
      starters.append(button);
    }
    const hint = document.createElement('p'); hint.className = 'conversation-composer-hint'; hint.id = 'conversationComposerHint';
    hint.textContent = 'Enter to send · Shift + Enter for a new line';
    const count = document.createElement('span'); count.className = 'conversation-character-count';
    input.setAttribute('aria-describedby', hint.id);
    host.append(starters, hint, count); form.after(host);
    function sync() {
      count.textContent = `${input.value.length} / ${input.maxLength}`;
      count.classList.toggle('near-limit', input.value.length >= input.maxLength * .9);
      starters.hidden = Boolean(input.value.trim());
      input.style.height = 'auto'; input.style.height = `${Math.min(180, Math.max(58, input.scrollHeight))}px`;
    }
    input.addEventListener('input', sync); sync();
    return { sync };
  }
  window.ConversationComposer = { mount };
})();
