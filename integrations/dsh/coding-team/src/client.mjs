/** Reject credential-bearing links and protocols other than HTTPS. */
export function normalizePipelineUrl(value) {
  if (typeof value !== 'string' || value.trim() !== value || /[\u0000-\u0020]/u.test(value)) throw new TypeError('Invalid Pipeline URL');
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password || url.search
      || url.pathname !== '/pipeline' || url.hash !== '#pipelineWorkerMonitor') throw new TypeError('Invalid Pipeline URL');
  return url.href;
}

/** Native Session navigation: no embedded Pipeline and no second task board. */
export function createClientPlugin(React, pipelineUrl) {
  const href = normalizePipelineUrl(pipelineUrl);
  return {
    inject: ['slots', 'connection', 'uiWorkspace', 'conversation', 'sessions'],
    apply(ctx) {
      const h = React.createElement;
      const blocked = new Set();
      ctx.effect(() => () => { for (const id of blocked) ctx.conversation.blocks.set(id, undefined); });
      function TeamSessions({ wide }) {
        const [open, setOpen] = React.useState(false);
        const [snapshot, setSnapshot] = React.useState({ sessions: [], error: null });
        const [error, setError] = React.useState(null);
        const [busy, setBusy] = React.useState(false);
        const requests = React.useRef(new Map());
        React.useEffect(() => {
          let disposed = false;
          const refresh = async () => {
            try {
              const response = await fetch('api/agentx-coding', { cache: 'no-store' });
              if (!response.ok) throw new Error('Session refresh failed');
              const value = await response.json();
              if (!disposed) {
                for (const item of value.sessions) {
                  ctx.conversation.blocks.set(item.sessionId, { reason: 'Observation du worker. Utilisez « Reprendre dans une copie » pour lui donner suite.' });
                  blocked.add(item.sessionId);
                }
                setSnapshot(value);
              }
            } catch { if (!disposed) setError('Connexion aux sessions indisponible'); }
          };
          void refresh();
          const timer = setInterval(refresh, 2000);
          return () => { disposed = true; clearInterval(timer); };
        }, []);
        const resume = async item => {
          setBusy(true);
          setError(null);
          let requestId = requests.current.get(item.sessionId);
          if (!requestId) {
            const key = `agentx-coding-handoff:${item.sessionId}`;
            try { requestId = localStorage.getItem(key); } catch { /* Optional browser persistence. */ }
            requestId ||= crypto.randomUUID();
            try { localStorage.setItem(key, requestId); } catch { /* Keep the in-memory identity. */ }
            requests.current.set(item.sessionId, requestId);
          }
          try {
            const response = await fetch('api/agentx-coding', { method: 'POST', headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ sessionId: item.sessionId, requestId }) });
            const value = await response.json();
            if (!response.ok) throw new Error(value.error);
            await ctx.sessions.refresh();
            ctx.uiWorkspace.openSession(value.sessionId);
            setOpen(false);
          } catch (failure) { setError(failure.message); } finally { setBusy(false); }
        };
        const buttonStyle = { cursor: 'pointer', padding: '7px 8px', borderRadius: 5,
          border: '1px solid var(--dsw-alias-border-primary)', background: 'transparent', color: 'inherit', font: 'inherit' };
        return h('div', { style: { position: 'relative', color: 'var(--dsw-alias-label-primary)' } },
          h('button', { type: 'button', onClick: () => setOpen(!open), 'aria-expanded': open,
            'data-agentx-coding-team': '', title: 'Sessions du coding team', style: buttonStyle }, wide ? 'Sessions du coding team' : '⌘'),
          open ? h('section', { 'aria-label': 'Sessions du coding team', style: {
            position: 'fixed', left: 12, bottom: 90, width: 'min(400px, calc(100vw - 24px))', maxHeight: '70vh', overflow: 'auto',
            padding: 14, borderRadius: 8, zIndex: 100, boxShadow: '0 4px 24px #0006',
            background: 'var(--dsw-alias-background-primary, #202020)', border: '1px solid #8886' } },
          h('strong', null, 'Conversations des workers'),
          h('p', null, 'Ouvrir montre les messages et les outils. Reprendre crée une session avec une copie des fichiers actuels.'),
          error || snapshot.error ? h('p', { role: 'alert' }, error || snapshot.error) : null,
          snapshot.loading ? h('p', { role: 'status' }, 'Chargement des historiques…') : null,
          !snapshot.loading && !snapshot.sessions.length ? h('p', null, 'Aucun historique de worker disponible.') : null,
          ...snapshot.sessions.map(item => h('div', { key: item.sessionId, style: { padding: '10px 0', borderTop: '1px solid #8884' } },
            h('div', null, `Tâche ${item.taskId} · ${item.turnOpen ? 'tour ouvert' : 'tour terminé'} · ${item.eventCount} événements`),
            h('small', null, item.sourceId.slice(-12)),
            item.error ? h('p', { role: 'alert' }, item.error) : null,
            h('div', { style: { display: 'flex', gap: 8, marginTop: 6 } },
              h('button', { type: 'button', style: buttonStyle, disabled: busy,
                onClick: () => { ctx.uiWorkspace.openSession(item.sessionId); setOpen(false); } }, 'Ouvrir'),
              h('button', { type: 'button', style: buttonStyle, disabled: busy || Boolean(item.error), onClick: () => resume(item) }, 'Reprendre dans une copie')))),
          h('a', { href, target: '_blank', rel: 'noopener noreferrer' }, 'Suivi des tâches dans Pipeline'),
          h('button', { type: 'button', style: { ...buttonStyle, marginLeft: 8 }, onClick: () => setOpen(false) }, 'Fermer')) : null);
      }
      ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register({
        name: 'sidebar.footer.action', id: 'agentx-coding-team', order: 20,
      }, TeamSessions));
    },
  };
}
