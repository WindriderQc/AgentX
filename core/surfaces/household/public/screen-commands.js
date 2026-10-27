'use strict';

// Short screen commands for Nestor's content workspace (#924): "agrandis",
// "ferme", "suivant"… act on the page at once, without a model turn. Only a
// complete short phrase is a command. Anything more ("ferme la tâche 0918",
// "agrandis la photo et explique-la") stays a request for Nestor: missing a
// command is better than taking a real request away from the model.
// The owner may add exact phrases of their own; Core keeps them (personal only).
(function exposeScreenCommands(root) {
  const NAME = 'nestor';
  // A wake phrase or the name makes the command addressed while Nestor waits for "Hey Nestor".
  const ADDRESS = `(?:(?:eille|heille|hey|hei|he|eh|ey|oh|ah|ok|okay) )?${NAME}`;
  const POLITE = '(?: (?:s il te plait|s il vous plait|svp|please))?';
  const FR_SCREEN = '(?:ecran|contenu|page|affichage|panneau|fenetre)';
  const FR_OBJECT = `(?: (?:l|le|la) ${FR_SCREEN}| ca)?`;
  const EN_SCREEN = '(?:screen|content|page|panel|display)';
  const EN_OBJECT = `(?: (?:it|that|this|the ${EN_SCREEN}))?`;
  const FR_TEXT = '(?:le texte|les caracteres|l ecriture)';
  const EN_TEXT = '(?:the )?(?:text|font)';

  const COMMANDS = {
    expand: [
      `agrandi(?:r|s|t)?${FR_OBJECT}`, `(?:mets?|mettre)(?: (?:le|la|ca|l ${FR_SCREEN}|le ${FR_SCREEN}|la ${FR_SCREEN}))? en (?:grand|plein ecran)`,
      'plus grand', 'plein ecran', `zoom(?:e|er|es|ez)?(?: avant)?${FR_OBJECT}`, `expand${EN_OBJECT}`, `maximi[sz]e${EN_OBJECT}`,
      `zoom in${EN_OBJECT}`, `make (?:it|that|the ${EN_SCREEN}) bigger`, 'bigger', 'full ?screen'
    ],
    shrink: [
      `redui(?:re|s|t)?${FR_OBJECT}`, 'plus petit', '(?:en )?taille normale', `de ?zoom(?:e|er|es|ez)?${FR_OBJECT}`, 'zoom arriere',
      `shrink${EN_OBJECT}`, `zoom out${EN_OBJECT}`, `make (?:it|that|the ${EN_SCREEN}) smaller`, 'smaller', 'normal size', 'exit full ?screen'
    ],
    textBigger: [
      `(?:agrandi(?:r|s|t)?|grossi(?:r|s|t)?) ${FR_TEXT}`, '(?:texte|ecriture) plus (?:grand|gros|grosse|grande)', 'plus gros',
      `(?:bigger|larger) ${EN_TEXT}`, `make ${EN_TEXT} (?:bigger|larger)`, `increase ${EN_TEXT} size`
    ],
    textSmaller: [
      `(?:redui(?:re|s|t)?|rapetisse(?:r|s|z)?) ${FR_TEXT}`, '(?:texte|ecriture) plus petite?', `smaller ${EN_TEXT}`,
      `make ${EN_TEXT} smaller`, `decrease ${EN_TEXT} size`
    ],
    close: [
      `ferme(?:r|s|z)?${FR_OBJECT}`, `(?:cache|masque)(?:r|s|z)?(?: (?:l|le|la) ${FR_SCREEN}| ca)`,
      `(?:close|hide)${EN_OBJECT}`
    ],
    show: [
      `re ?affiche(?:r|s|z)?${FR_OBJECT}`, `r(?:e )?ouvr(?:e|es|ez|ir)${FR_OBJECT}`,
      `(?:affiche|montre)(?:r|s|z)? (?:l|le|la) ${FR_SCREEN}(?: (?:de nouveau|encore))?`, '(?:affiche|montre)(?:r|s|z)?(?: le| la| ca)? (?:de nouveau|encore)',
      `show (?:it|that|the ${EN_SCREEN}) again`, 'show again', `reopen${EN_OBJECT}`, `show the ${EN_SCREEN}`
    ],
    previous: [
      '(?:(?:le|la|au) )?precedente?', `${FR_SCREEN} precedente?`, 'reviens(?: en arriere)?', 'retour(?: en arriere)?', 'en arriere',
      `previous(?: (?:one|${EN_SCREEN}))?`, 'go back', 'back'
    ],
    next: [
      '(?:(?:le|la|au) )?suivante?', `${FR_SCREEN} suivante?`, `next(?: (?:one|${EN_SCREEN}))?`
    ],
    first: [
      `(?:premier ${FR_SCREEN}|premiere page)`, '(?:va|retourne|reviens|retour) au (?:premier|debut)', 'au debut',
      `first ${EN_SCREEN}`, 'go to the (?:first|beginning)(?: one)?', 'go to first'
    ],
    last: [
      `(?:dernier ${FR_SCREEN}|derniere page)`, 'va au dernier', `last ${EN_SCREEN}`, 'go to the last(?: one)?', 'go to last'
    ],
    scrollDown: [
      '(?:descend(?:s|re)?|redescends?)(?: un peu)?', 'plus bas', '(?:defile|defiler|fais defiler)(?: vers le bas)?', 'scroll(?: down)?', 'page down', 'go down'
    ],
    scrollUp: [
      '(?:re)?mont(?:e|es|er)(?: un peu)?', 'plus haut', '(?:defile|defiler|fais defiler) vers le haut', 'scroll up', 'page up', 'go up'
    ],
    openTab: [
      `ouvr(?:e|ir)(?: (?:la|le|ca|la page|le contenu))? dans un (?:nouvel )?onglet`, 'nouvel onglet',
      `open(?: (?:it|that|this|the ${EN_SCREEN}))? in a (?:new )?tab`, 'new tab'
    ]
  };
  // What the editor shows for each action; every example is a tested command.
  const ACTIONS = Object.freeze({
    expand: { label: 'Agrandir la zone', examples: ['agrandis', 'plus grand', 'zoom avant', 'expand', 'zoom in'] },
    shrink: { label: 'Réduire la zone', examples: ['réduis', 'plus petit', 'dézoome', 'smaller', 'zoom out'] },
    textBigger: { label: 'Texte plus grand', examples: ['agrandis le texte', 'plus gros', 'bigger text'] },
    textSmaller: { label: 'Texte plus petit', examples: ['réduis le texte', 'texte plus petit', 'smaller text'] },
    close: { label: 'Fermer le contenu', examples: ['ferme', 'cache l’écran', 'close'] },
    show: { label: 'Réafficher le contenu', examples: ['réaffiche', 'rouvre', 'show it again'] },
    previous: { label: 'Contenu précédent', examples: ['précédent', 'reviens', 'previous'] },
    next: { label: 'Contenu suivant', examples: ['suivant', 'page suivante', 'next'] },
    first: { label: 'Premier contenu', examples: ['premier contenu', 'va au premier', 'go to first'] },
    last: { label: 'Dernier contenu', examples: ['dernier contenu', 'va au dernier', 'go to last'] },
    scrollDown: { label: 'Défiler vers le bas', examples: ['descends', 'plus bas', 'scroll down'] },
    scrollUp: { label: 'Défiler vers le haut', examples: ['monte', 'plus haut', 'scroll up'] },
    openTab: { label: 'Ouvrir dans un onglet', examples: ['ouvre dans un onglet', 'open in a new tab'] }
  });
  const wrap = body => new RegExp(`^(?:(${ADDRESS}) )?(?:${body})${POLITE}(?: (${NAME}))?${POLITE}$`);
  const PATTERNS = Object.entries(COMMANDS).map(([action, forms]) => [action, wrap(forms.join('|'))]);
  const MAX_CUSTOM = 40, MAX_PHRASE = 40, MAX_WORDS = 5;

  function normalize(text) {
    return String(text || '').normalize('NFD').replace(/[̀-ͯ]/g, '')
      .toLowerCase().replace(/[\p{P}\p{S}]/gu, ' ').replace(/\s+/g, ' ').trim();
  }

  function builtIn(normalized) {
    for (const [action, pattern] of PATTERNS) {
      const match = pattern.exec(normalized);
      if (match) return { action, addressed: Boolean(match[1] || match[2]) };
    }
    return null;
  }

  // The owner's phrases match exactly, with the same optional name and politeness.
  const customCache = new WeakMap();
  function customPatterns(phrases) {
    if (!Array.isArray(phrases) || !phrases.length) return [];
    if (customCache.has(phrases)) return customCache.get(phrases);
    const patterns = phrases.filter(item => ACTIONS[item?.action] && normalize(item.phrase))
      .map(item => [item.action, wrap(normalize(item.phrase).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))]);
    customCache.set(phrases, patterns);
    return patterns;
  }

  // { action, addressed } for a complete screen command, otherwise null.
  function parse(text, phrases = []) {
    const normalized = normalize(text);
    if (!normalized || normalized.length > 80) return null;
    const found = builtIn(normalized);
    if (found) return found;
    for (const [action, pattern] of customPatterns(phrases)) {
      const match = pattern.exec(normalized);
      if (match) return { action, addressed: Boolean(match[1] || match[2]), custom: true };
    }
    return null;
  }

  // The same rules in the browser editor and in Core. A phrase is short, new,
  // never a built-in command, and never names Nestor: wake and sleep phrases stay intact.
  function validate(list) {
    if (!Array.isArray(list)) return { error: 'Une liste de phrases est requise.' };
    if (list.length > MAX_CUSTOM) return { error: `Au plus ${MAX_CUSTOM} phrases.` };
    const seen = new Set(), phrases = [];
    for (const item of list) {
      if (!item || typeof item !== 'object' || Object.keys(item).some(key => !['phrase', 'action'].includes(key))) return { error: 'Chaque phrase a seulement un texte et une action.' };
      if (!ACTIONS[item.action]) return { error: 'Action inconnue.' };
      const phrase = typeof item.phrase === 'string' ? item.phrase.trim().replace(/\s+/g, ' ') : '';
      const normalized = normalize(phrase);
      if (!/[a-z]/.test(normalized) || normalized.length < 2 || normalized.length > MAX_PHRASE || phrase.length > MAX_PHRASE * 2
        || normalized.split(' ').length > MAX_WORDS) return { error: `« ${phrase || '…'} » : entre 2 et ${MAX_PHRASE} caractères, ${MAX_WORDS} mots au plus.`, phrase };
      if (normalized.split(' ').includes(NAME)) return { error: `« ${phrase} » : sans le nom Nestor, il est déjà accepté autour de la commande.`, phrase };
      const existing = builtIn(normalized);
      if (existing) return { error: `« ${phrase} » est déjà reconnu (${ACTIONS[existing.action].label}).`, phrase };
      if (seen.has(normalized)) return { error: `« ${phrase} » est en double.`, phrase };
      seen.add(normalized); phrases.push({ phrase, action: item.action });
    }
    return { phrases };
  }

  // `screen.command(action)` returns null when the workspace has no content:
  // then the phrase is not taken away from Nestor. `followup` is false while a
  // wake word is required and the conversation is on standby.
  function handler(screen, { phrases = () => [] } = {}) {
    return (text, { followup = true } = {}) => {
      const command = parse(text, phrases());
      if (!command || (!followup && !command.addressed) || typeof screen?.command !== 'function') return null;
      const result = screen.command(command.action);
      return result ? { ...result, addressed: command.addressed } : null;
    };
  }

  const api = Object.freeze({ parse, validate, handler, normalize, ACTIONS, actions: Object.freeze(Object.keys(COMMANDS)), MAX_CUSTOM });
  root.NestorScreenCommands = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
}(typeof window !== 'undefined' ? window : globalThis));
