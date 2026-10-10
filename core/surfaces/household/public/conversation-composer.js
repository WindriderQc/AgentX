/* Help people start a conversation without sending or replacing their draft. */
(function () {
  'use strict';
  const prompts = {
    personal: [['Ma journée', 'Aide-moi à organiser ma journée à partir de mes tâches.'], ['Une tâche', 'Aide-moi à préciser une tâche avant de l’ajouter à ma liste.'], ['Réfléchir ensemble', 'Aide-moi à réfléchir à une décision, une question à la fois.']],
    family: [['Comprendre', 'Explique-moi quelque chose avec un exemple simple.'], ['Pratiquer', 'Aide-moi à pratiquer, une question à la fois.'], ['Une petite étape', 'Aide-moi à commencer une tâche sécuritaire, une petite étape à la fois.']]
  };
  function mount({ input, form, family }) {
    const host = document.createElement('div'); host.className = 'conversation-composer-help';
    const starters = document.createElement('div'); starters.className = 'conversation-starters';
    starters.setAttribute('role', 'group'); starters.setAttribute('aria-label', 'Idées pour commencer');
    for (const [label, text] of prompts[family ? 'family' : 'personal']) {
      const button = document.createElement('button'); button.type = 'button'; button.textContent = label;
      button.onclick = () => { if (input.value.trim()) return; input.value = text; input.dispatchEvent(new Event('input')); input.focus(); };
      starters.append(button);
    }
    const hint = document.createElement('p'); hint.className = 'conversation-composer-hint'; hint.id = 'conversationComposerHint';
    hint.textContent = 'Entrée pour envoyer · Maj + Entrée pour une nouvelle ligne';
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
