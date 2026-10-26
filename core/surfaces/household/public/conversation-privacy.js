/* Conversation-local choice; never stored in browser preferences or history. */
(function expose(root) {
  'use strict';
  function create() {
    let ephemeral = false, manual = null;
    return {
      select(open) { if (manual === null && open) ephemeral = true; return this.snapshot(); },
      choose(value) { ephemeral = manual = value === true; return this.snapshot(); },
      reset(open = false) { manual = null; ephemeral = open === true; return this.snapshot(); },
      restore(session) { ephemeral = session?.ephemeral === true; manual = session?.ephemeralExplicit ? ephemeral : null; return this.snapshot(); },
      snapshot() { return Object.freeze({ ephemeral, ephemeralExplicit: manual !== null }); }
    };
  }
  const notice = 'Ces nouveaux échanges ne sont pas ajoutés à l’historique conservé ni à la mémoire. La mémoire personnelle et les recherches RAG ne sont pas consultées. Le contexte actif et les pièces jointes restent en mémoire vive de Core, au plus 30 minutes sans accès, et dans cet onglet tant qu’il est ouvert. Les outils gardent leurs autorisations ; leurs actions peuvent conserver des données dans les services utilisés (par exemple une image et sa description dans l’Atelier). Les journaux Core de conversation et d’inférence gardent les identifiants, tailles, durées et erreurs génériques. Le modèle reçoit le contexte et peut le garder dans son cache. Les services vocaux reçoivent l’audio et le texte des réponses ; leur éventuelle conservation n’est pas pilotée par ce bouton.';
  const boundary = 'La conservation commence avec les prochains échanges dans un nouveau contexte. Les échanges éphémères précédents, les pièces jointes et ce qui est affiché à l’écran ne sont pas envoyés à ce contexte ni ajoutés à l’historique ou à la mémoire.';
  const prior = 'Les échanges déjà conservés restent conservés. Le choix s’applique aux prochains échanges ; une requête en cours garde sa politique initiale.';
  root.ConversationPrivacy = { create, notice, boundary, prior };
  if (typeof module !== 'undefined') module.exports = root.ConversationPrivacy;
}(typeof window !== 'undefined' ? window : globalThis));
