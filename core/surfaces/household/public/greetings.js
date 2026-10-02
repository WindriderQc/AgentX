/* What Nestor says when he wakes up, and when "Hey Nestor" wakes him.
   Warm, short, varied by time of day and space, never the same line twice in a
   row. In wake-word mode the greeting says how to wake him instead of claiming
   to listen to everything. The docked face opens its eyes on the first word. */
(function (root) {
  'use strict';
  const LINES = {
    fr: {
      personal: {
        morning: ['Bon matin ! Par quoi on commence ?', 'Salut, bien réveillé ! On attaque quoi ce matin ?'],
        day: ['Salut ! Me voilà. Qu’est-ce qu’on attaque ?', 'Me voilà ! Sur quoi on travaille ?'],
        evening: ['Bonsoir ! Qu’est-ce que je peux faire pour toi ?', 'Me voilà. On regarde quoi ce soir ?'],
        night: ['Je suis là, même à cette heure-ci. Qu’est-ce qu’il te faut ?']
      },
      family: {
        morning: ['Bon matin la famille !', 'Coucou ! Bien dormi ?'],
        day: ['Coucou tout le monde ! Me voilà.', 'Allô la famille ! Je suis réveillé.'],
        evening: ['Bonsoir la famille !', 'Coucou ! Me voilà pour la soirée.'],
        night: ['Coucou… je suis là, tout doucement.']
      },
      listening: ' Je t’écoute !',
      wakeWord: ' Dis « Hey Nestor » quand tu veux me parler.',
      wake: ['Oui ?', 'Je t’écoute !', 'Oui, je suis là !', 'Dis-moi !']
    },
    en: {
      personal: {
        morning: ['Good morning! Where do we start?', 'Hi, wide awake! What are we tackling this morning?'],
        day: ['Hi! Here I am. What are we tackling?', 'Here I am! What are we working on?'],
        evening: ['Good evening! What can I do for you?', 'Here I am. What are we looking at tonight?'],
        night: ['I’m here, even at this hour. What do you need?']
      },
      family: {
        morning: ['Good morning, family!', 'Hi! Did you sleep well?'],
        day: ['Hi everyone! Here I am.', 'Hello family! I’m awake.'],
        evening: ['Good evening, family!', 'Hi! I’m here for the evening.'],
        night: ['Hi… I’m here, softly.']
      },
      listening: ' I’m listening!',
      wakeWord: ' Say “Hey Nestor” whenever you want to talk to me.',
      wake: ['Yes?', 'I’m listening!', 'I’m here!', 'Tell me!']
    }
  };

  function partOfDay(hour) {
    if (hour >= 5 && hour < 11) return 'morning';
    if (hour >= 11 && hour < 18) return 'day';
    if (hour >= 18 && hour < 23) return 'evening';
    return 'night';
  }

  // One line from a list, never the previous one when there is a choice.
  function choose(list, previous, pick) {
    const fresh = list.length > 1 ? list.filter(line => !previous || !previous.startsWith(line)) : list;
    return fresh[Math.min(fresh.length - 1, Math.floor(pick() * fresh.length))];
  }

  function greetingFor({ space = 'personal', language = 'fr', wakeWord = false, hour = new Date().getHours(), previous = '', pick = Math.random } = {}) {
    const lines = LINES[language === 'en' ? 'en' : 'fr'];
    const opening = choose(lines[space === 'family' ? 'family' : 'personal'][partOfDay(hour)], previous, pick);
    return opening + (wakeWord ? lines.wakeWord : lines.listening);
  }

  function wakeReply({ language = 'fr', previous = '', pick = Math.random } = {}) {
    return choose(LINES[language === 'en' ? 'en' : 'fr'].wake, previous, pick);
  }

  const api = { greetingFor, wakeReply, partOfDay };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.NestorGreetings = api;
})(typeof window === 'undefined' ? globalThis : window);
