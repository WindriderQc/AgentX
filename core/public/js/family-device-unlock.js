// Banner of a family device the owner unlocked (#826): the time full access
// ends, and Relock. At that time, or after Relock, the page returns to the
// family profile.
(function () {
  'use strict';
  const banner = document.querySelector('.family-unlock-banner');
  if (!banner) return;
  const until = new Date(banner.dataset.familyUnlockUntil);
  const time = banner.querySelector('[data-family-unlock-time]');
  if (time && !Number.isNaN(until.getTime())) time.textContent = until.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const back = () => window.location.assign('/panel');
  const left = until.getTime() - Date.now();
  if (Number.isFinite(left)) setTimeout(back, Math.max(0, left) + 1000);
  banner.querySelector('[data-family-relock]')?.addEventListener('click', async (event) => {
    event.currentTarget.disabled = true;
    try {
      const response = await fetch('/api/household/family-device/relock', { method: 'POST', credentials: 'include' });
      if (!response.ok) throw new Error('relock failed');
      back();
    } catch {
      event.currentTarget.disabled = false;
      banner.querySelector('span').textContent = 'Relock failed; try again.';
    }
  });
})();
