import { fetchWithDeadline } from './chat-network.js';
let nextCursor = null, loading = false;

// Core owns these copies; the browser keeps no second personal-content store.
async function fetchExchange(path, options = {}) {
  const response = await fetchWithDeadline(path, { credentials: 'include', cache: 'no-store', ...options }, 15000);
  if (!response.ok) throw new Error(`Saved exchange unavailable (${response.status}).`);
  return response;
}
function download(value, id) {
  const url = URL.createObjectURL(new Blob([JSON.stringify(value, null, 2)], { type: 'application/json' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = `agentx-exchange-${id}.json`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export async function refreshSavedExchanges({ append = false } = {}) {
  const list = document.getElementById('exchangeRecoveryList');
  const status = document.getElementById('exchangeRecoveryStatus');
  const older = document.getElementById('exchangeRecoveryOlder');
  if (!list || !status || loading || append && !nextCursor) return;
  loading = true;
  if (older) older.disabled = true;
  status.textContent = 'Loading saved exchanges…';
  try {
    const path = '/api/history/receipts' + (append ? `?cursor=${encodeURIComponent(nextCursor)}` : '');
    const page = await (await fetchExchange(path)).json();
    const data = page.data;
    nextCursor = page.nextCursor;
    if (!append) list.replaceChildren();
    for (const row of data) {
      const item = document.createElement('li');
      const label = document.createElement('span');
      const at = row.createdAt ? new Date(row.createdAt).toLocaleString() : 'Saved exchange';
      label.textContent = `${at} · ${row.state === 'accepted' ? 'In progress or interrupted' : row.state === 'interrupted'
        ? 'Interrupted' : row.statusCode >= 400 ? `Request refused (${row.statusCode})` : 'Saved response'}`;
      const recover = document.createElement('button');
      recover.type = 'button';
      recover.className = 'ghost';
      recover.textContent = 'Download';
      recover.setAttribute('aria-label', `Download saved exchange from ${at}`);
      recover.addEventListener('click', async () => {
        recover.disabled = true;
        try { download(await (await fetchExchange(`/api/history/receipts/${encodeURIComponent(row.id)}`)).json(), row.id); }
        catch (error) { status.textContent = error.message; }
        finally { recover.disabled = false; }
      });
      const erase = document.createElement('button');
      erase.type = 'button';
      erase.className = 'ghost';
      erase.textContent = 'Erase copy';
      erase.setAttribute('aria-label', `Erase recovery copy from ${at}`);
      erase.addEventListener('click', async () => {
        erase.disabled = true;
        try {
          await fetchExchange(`/api/history/receipts/${encodeURIComponent(row.id)}`, { method: 'DELETE' });
          await refreshSavedExchanges();
        } catch (error) { status.textContent = error.message; }
        finally { erase.disabled = false; }
      });
      item.append(label, recover, erase);
      list.append(item);
    }
    status.textContent = list.children.length ? `${list.children.length} saved exchanges available. Downloading never sends the request again.`
      : 'No refused or interrupted exchanges to recover.';
  } catch (error) { status.textContent = error.message; }
  finally {
    loading = false;
    if (older) { older.disabled = !nextCursor; older.hidden = !nextCursor; }
  }
}

const panel = document.getElementById('exchangeRecovery');
panel?.addEventListener('toggle', () => { if (panel.open) void refreshSavedExchanges(); });
document.getElementById('exchangeRecoveryRefresh')?.addEventListener('click', () => void refreshSavedExchanges());
document.getElementById('exchangeRecoveryOlder')?.addEventListener('click', () => void refreshSavedExchanges({ append: true }));
