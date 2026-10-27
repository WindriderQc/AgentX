'use strict';

// Short screen commands for Nestor's content workspace (#924): "agrandis",
// "ferme", "suivant"… act on the page at once, without a model turn. Only a
// complete short phrase is a command. Anything more ("ferme la tâche 0918",
// "agrandis la photo et explique-la") stays a request for Nestor: missing a
// command is better than taking a real request away from the model.
(function exposeScreenCommands(root) {
  const NAME = 'nestor';
  // A wake phrase or the name makes the command addressed while Nestor waits for "Hey Nestor".
  const ADDRESS = `(?:(?:eille|heille|hey|hei|he|eh|ey|oh|ah|ok|okay) )?${NAME}`;
  const POLITE = '(?: (?:s il te plait|s il vous plait|svp|please))?';
  const FR_SCREEN = '(?:ecran|contenu|page|affichage|panneau|fenetre)';
  const FR_OBJECT = `(?: (?:l|le|la) ${FR_SCREEN}| ca)?`;
  const EN_SCREEN = '(?:screen|content|page|panel|display)';
  const EN_OBJECT = `(?: (?:it|that|this|the ${EN_SCREEN}))?`;

  const COMMANDS = {
    expand: [
      `agrandi(?:r|s|t)?${FR_OBJECT}`, `(?:mets?|mettre)(?: (?:le|la|ca|l ${FR_SCREEN}|le ${FR_SCREEN}|la ${FR_SCREEN}))? en (?:grand|plein ecran)`,
      'plus grand', 'plein ecran', `expand${EN_OBJECT}`, `maximi[sz]e${EN_OBJECT}`,
      `make (?:it|that|the ${EN_SCREEN}) bigger`, 'bigger', 'full ?screen'
    ],
    shrink: [
      `redui(?:re|s|t)?${FR_OBJECT}`, 'plus petit', '(?:en )?taille normale',
      `shrink${EN_OBJECT}`, `make (?:it|that|the ${EN_SCREEN}) smaller`, 'smaller', 'normal size', 'exit full ?screen'
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
      `(?:(?:le|la|au|l) )?precedente?`, `${FR_SCREEN} precedente?`, 'reviens(?: en arriere)?', 'retour(?: en arriere)?', 'en arriere',
      `previous(?: (?:one|${EN_SCREEN}))?`, 'go back', 'back'
    ],
    next: [
      '(?:(?:le|la|au) )?suivante?', `${FR_SCREEN} suivante?`, `next(?: (?:one|${EN_SCREEN}))?`
    ]
  };
  const PATTERNS = Object.entries(COMMANDS).map(([action, forms]) => [action,
    new RegExp(`^(?:(${ADDRESS}) )?(?:${forms.join('|')})${POLITE}(?: (${NAME}))?${POLITE}$`)]);

  function normalize(text) {
    return String(text || '').normalize('NFD').replace(/[̀-ͯ]/g, '')
      .toLowerCase().replace(/[\p{P}\p{S}]/gu, ' ').replace(/\s+/g, ' ').trim();
  }

  // { action, addressed } for a complete screen command, otherwise null.
  function parse(text) {
    const normalized = normalize(text);
    if (!normalized || normalized.length > 60) return null;
    for (const [action, pattern] of PATTERNS) {
      const match = pattern.exec(normalized);
      if (match) return { action, addressed: Boolean(match[1] || match[2]) };
    }
    return null;
  }

  // `screen.command(action)` returns null when the workspace has no content:
  // then the phrase is not taken away from Nestor. `followup` is false while a
  // wake word is required and the conversation is on standby.
  function handler(screen) {
    return (text, { followup = true } = {}) => {
      const command = parse(text);
      if (!command || (!followup && !command.addressed) || typeof screen?.command !== 'function') return null;
      const result = screen.command(command.action);
      return result ? { ...result, addressed: command.addressed } : null;
    };
  }

  const api = Object.freeze({ parse, handler, normalize, actions: Object.freeze(Object.keys(COMMANDS)) });
  root.NestorScreenCommands = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
}(typeof window !== 'undefined' ? window : globalThis));
