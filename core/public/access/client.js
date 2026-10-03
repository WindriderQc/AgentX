(() => {
  'use strict';
  const nativeFetch = window.fetch.bind(window);
  const family = ['/panel', '/kids', '/kids/sounds', '/lecture'].includes(location.pathname.replace(/\/+$/, ''));
  const landing = ['/', '/portal', '/ecosystem'].includes(location.pathname.replace(/\/+$/, '') || '/');
  const publicPage = family || landing;
  let enforced = false, closed = false, timer;
  let channel;
  try { channel = new BroadcastChannel('agentx-adult-access'); } catch { /* refresh/expiry still enforce the server session */ }
  // The common landing and family pages contain no private application data.
  // Their destinations still pass through the existing server access guard.
  function markLocked() {
    document.documentElement.dataset.agentxAccess = 'locked';
    if (landing) {
      document.getElementById('homeServiceDetails')?.replaceChildren();
      const consistency = document.getElementById('homeConsistency');
      if (consistency) consistency.textContent = '';
    }
  }
  function close(broadcast = false) {
    if (!enforced || closed) return;
    closed = true; clearTimeout(timer);
    if (broadcast) channel?.postMessage('locked');
    if (publicPage) { markLocked(); return; }
    document.documentElement.classList.add('agentx-access-checking');
    document.body.replaceChildren();
    location.replace('/unlock?next=' + encodeURIComponent(location.pathname + location.search));
  }
  window.AgentXAccess = {
    assertCurrent() { if (closed && !publicPage) throw new DOMException('Adult access closed', 'AbortError'); }
  };
  channel?.addEventListener('message', event => { if (event.data === 'locked') close(); });
  window.fetch = async (input, options) => {
    const response = await nativeFetch(input, options);
    if (enforced) {
      const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url, location.href);
      if (url.origin === location.origin) {
        if (response.ok && ['/api/access/lock', '/api/psyx/auth/lock'].includes(url.pathname)) close(true);
        else if (response.status === 401 && (await response.clone().json().catch(() => ({}))).code === 'ADULT_LOCKED') close(true);
      }
    }
    window.AgentXAccess.assertCurrent();
    return response;
  };
  async function check() {
    try {
      const response = await nativeFetch('/api/access/session', { credentials: 'same-origin', cache: 'no-store' });
      if (!response.ok) return;
      const { data } = await response.json();
      enforced = data.enforced;
      if (!enforced) return;
      if (data.unlocked) { closed = false; document.documentElement.dataset.agentxAccess = 'unlocked'; }
      if (!data.unlocked) { close(family); return; }
      clearTimeout(timer);
      timer = setTimeout(() => close(true), Math.max(0, data.expiresAt - Date.now()));
      if (!family && !document.getElementById('agentxAdultLock')) {
        const button = document.createElement('button');
        button.id = 'agentxAdultLock'; button.className = 'agentx-adult-lock';
        button.type = 'button'; button.textContent = 'Verrouiller l’espace adulte';
        button.onclick = async () => {
          button.disabled = true;
          try {
            const result = await nativeFetch('/api/access/lock', { method: 'POST', credentials: 'same-origin' });
            if (!result.ok) throw new Error('Lock failed');
            close(true);
          } catch { button.disabled = false; button.textContent = 'Réessayer le verrouillage'; }
        };
        (document.querySelector('.nav-tools-panel') || document.body).append(button);
      }
    } catch { if (enforced && !publicPage) close(); }
    finally { if (!closed || publicPage) document.documentElement.classList.remove('agentx-access-checking'); }
  }
  addEventListener('pagehide', () => { if (enforced && !publicPage) document.documentElement.classList.add('agentx-access-checking'); });
  addEventListener('pageshow', check);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) check(); });
  check();
})();
