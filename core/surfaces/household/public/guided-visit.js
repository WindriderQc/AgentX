/* A user-opened destination may keep this conversation audible in another
 * tab. The visible notice and End control belong to this visit only. */
(function (root) {
  'use strict';
  function mount({ host, onExpire = () => {}, documentRef = root.document, maxMs = 30 * 60 * 1000 }) {
    let timer, active = false;
    const notice = documentRef.createElement('p'); notice.className = 'conversation-visit'; notice.hidden = true;
    notice.setAttribute('role', 'status');
    const label = documentRef.createElement('span');
    const end = documentRef.createElement('button'); end.type = 'button'; end.className = 'button'; end.textContent = 'Terminer la visite';
    notice.append(label, end); host.append(notice);
    function finish() { active = false; clearTimeout(timer); notice.hidden = true; }
    function start(event) {
      const name = String(event.detail?.label || '').slice(0, 80);
      if (!name) return;
      active = true; notice.hidden = false;
      label.textContent = `Visite de ${name} · la conversation reste active dans cet onglet. Revenez ici pour parler, arrêter le micro ou terminer la visite. `;
      clearTimeout(timer);
      timer = setTimeout(() => { finish(); onExpire(); }, maxMs);
      timer.unref?.();
    }
    function visibility() { if (!documentRef.hidden) finish(); }
    end.addEventListener('click', finish);
    root.addEventListener('nestor-guided-visit', start);
    documentRef.addEventListener('visibilitychange', visibility);
    return { active: () => active, finish,
      dispose() { finish(); notice.remove(); root.removeEventListener('nestor-guided-visit', start); documentRef.removeEventListener('visibilitychange', visibility); } };
  }
  root.NestorGuidedVisit = { mount };
  if (typeof module === 'object' && module.exports) module.exports = { mount };
})(typeof window === 'undefined' ? globalThis : window);
