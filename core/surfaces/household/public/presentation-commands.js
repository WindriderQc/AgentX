'use strict';

// What a spoken or typed screen command does in Nestor's content workspace
// (#924). The same effects as the toolbar buttons, plus text size, scrolling
// and opening the shown page in a tab. Nothing is ever removed; a command that
// cannot apply only says so in a short status line.
(function exposePresentationCommands(root) {
  const TEXT_ZOOM = [0.85, 1, 1.25, 1.5, 1.75, 2];
  const NORMAL_ZOOM = 1;
  const SCROLLABLE = '.display-block-text, .display-block-table, .display-block-code, .display-block-links';

  function create({ region, picker, feedback, cards, selected, select, present, setExpanded }) {
    let feedbackTimer = null, zoom = NORMAL_ZOOM;
    const is = name => region.classList.contains(name);
    const label = () => picker.selectedOptions?.[0]?.textContent || '';

    function say(message) {
      feedback.textContent = message;
      clearTimeout(feedbackTimer);
      feedbackTimer = setTimeout(() => { feedback.textContent = ''; }, 3000);
    }
    function goTo(index, edge) {
      const list = cards(), target = list[index];
      if (!target) return edge;
      if (target === selected() && is('is-active')) return edge;
      select(target); present(true);
      return null;
    }
    function textZoom(step) {
      const index = TEXT_ZOOM.indexOf(zoom) + step;
      if (index < 0) return 'Texte déjà au plus petit.';
      if (index >= TEXT_ZOOM.length) return 'Texte déjà au plus grand.';
      zoom = TEXT_ZOOM[index];
      region.style.setProperty('--presentation-text-zoom', String(zoom));
      return null;
    }
    // A same-origin page scrolls inside its frame; a card scrolls its own text,
    // or the page moves past it. Another service's frame cannot be scrolled from here.
    function scroll(direction) {
      const card = selected();
      if (!card || !is('is-active')) return 'Le contenu est fermé.';
      let target = null;
      if (card._screenFrame) {
        try { target = card._screenFrame.contentDocument?.scrollingElement; } catch { target = null; }
        if (!target) return 'Ce service ne se laisse pas faire défiler d’ici.';
      } else {
        target = Array.from(card.querySelectorAll(SCROLLABLE)).find(element => element.scrollHeight > element.clientHeight + 1)
          || root.document.scrollingElement;
      }
      const view = target === root.document.scrollingElement ? root.innerHeight : target.clientHeight;
      if (direction > 0 && target.scrollTop + target.clientHeight >= target.scrollHeight - 2) return 'Déjà en bas.';
      if (direction < 0 && target.scrollTop <= 0) return 'Déjà en haut.';
      target.scrollBy({ top: direction * Math.max(80, Math.round(view * 0.8)), behavior: 'smooth' });
      return null;
    }
    // Browsers open a tab only from a recent click or key press, so a spoken
    // command points at the link instead of pretending it opened.
    function openTab() {
      const link = selected()?.querySelector('a.display-block-action[target="_blank"]');
      if (!link) return 'Ce contenu n’a pas de page à ouvrir.';
      if (root.navigator?.userActivation && !root.navigator.userActivation.isActive) {
        if (!is('is-active')) present(true);
        link.focus();
        return 'Touchez « Ouvrir dans un onglet » : le navigateur bloque l’ouverture à la voix.';
      }
      link.click();
      return null;
    }

    const ACTIONS = {
      expand: () => !is('is-active') ? 'Le contenu est fermé.' : is('is-expanded') ? 'Déjà agrandi.' : void setExpanded(true),
      shrink: () => !is('is-expanded') ? 'Déjà à la taille normale.' : void setExpanded(false),
      close: () => !is('is-active') ? 'Le contenu est déjà fermé.' : void present(false),
      show: () => is('is-active') ? 'Le contenu est déjà affiché.' : void present(true),
      previous: () => goTo(cards().indexOf(selected()) - 1, 'Déjà au premier contenu.'),
      next: () => goTo(cards().indexOf(selected()) + 1, 'Déjà au dernier contenu.'),
      first: () => goTo(0, 'Déjà au premier contenu.'),
      last: () => goTo(cards().length - 1, 'Déjà au dernier contenu.'),
      textBigger: () => textZoom(1),
      textSmaller: () => textZoom(-1),
      scrollDown: () => scroll(1),
      scrollUp: () => scroll(-1),
      openTab
    };
    const DONE = {
      expand: () => 'Contenu agrandi.', shrink: () => 'Taille normale.', close: () => 'Contenu fermé.', show: () => 'Contenu affiché.',
      previous: () => `Contenu précédent : ${label()}`, next: () => `Contenu suivant : ${label()}`,
      first: () => `Premier contenu : ${label()}`, last: () => `Dernier contenu : ${label()}`,
      textBigger: () => `Texte à ${Math.round(zoom * 100)} %.`, textSmaller: () => `Texte à ${Math.round(zoom * 100)} %.`,
      scrollDown: () => 'Défilement vers le bas.', scrollUp: () => 'Défilement vers le haut.', openTab: () => 'Page ouverte dans un onglet.'
    };

    // null when the workspace has nothing to act on: the phrase then goes to Nestor.
    function command(action) {
      if (!cards().length || region.hidden || !ACTIONS[action]) return null;
      const refusal = ACTIONS[action]() || null;
      const message = refusal || DONE[action]();
      say(message);
      return { action, applied: !refusal, message };
    }
    return { command, say };
  }

  root.NestorPresentationCommands = Object.freeze({ create, TEXT_ZOOM });
}(typeof window !== 'undefined' ? window : globalThis));
