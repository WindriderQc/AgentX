/* Conversation notice while Core relays speech through the backup VoiX host. */
(function (root) {
  'use strict';
  const BACKUP_NOTICE = 'Voix de secours (serveur principal indisponible) : réponses plus lentes.';

  // Accepts an X-Voix-Upstream header value or a GET /api/voix/upstream payload.
  function upstreamNotice(state) {
    const active = typeof state === 'string' ? state : state?.active;
    return String(active || '').trim().toLowerCase() === 'fallback' ? BACKUP_NOTICE : '';
  }

  // The voice-choice ladder notice and the backup notice can both apply.
  function composeNotice(ladderText, upstreamState) {
    return [ladderText, upstreamNotice(upstreamState)].filter(Boolean).join(' ');
  }

  const api = { BACKUP_NOTICE, upstreamNotice, composeNotice };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.NestorVoixUpstream = api;
})(typeof window === 'undefined' ? globalThis : window);
