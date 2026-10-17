/* Family devices (#826): pin the device in hand to the family profile, and unpin
   others. A pinned device only reaches family pages, so it can never open this
   card to unpin itself. */
window.HouseholdFamilyDevices = { mount({ host, api, esc, toast }) {
  host.innerHTML = `<details class="family-disclosure" id="familyDevices"><summary>Family devices <span id="familyDevicesCount" class="pill">0</span></summary>
    <p class="muted">A pinned device, such as a child’s tablet, only opens Nestor Family, Kids, Reading and the family voice settings. Personal pages, your memories and settings stay out of reach. Unpin it from another device. Clearing the tablet’s browser data also removes the pin.</p>
    <form id="familyDevicePin" class="row wrap"><label class="grow"><span>Name for this device</span><input id="familyDeviceLabel" maxlength="80" placeholder="Tablet in the living room"></label><button type="submit">Pin this device to Famille</button></form>
    <ul id="familyDeviceList" class="profile-list"></ul><p id="familyDeviceStatus" class="muted" role="status"></p></details>`;
  const list = host.querySelector('#familyDeviceList');
  const status = host.querySelector('#familyDeviceStatus');
  const when = value => value ? new Date(value).toLocaleString() : 'never';

  async function refresh() {
    try {
      const { devices } = await api('/api/household/family-devices');
      host.querySelector('#familyDevicesCount').textContent = String(devices.length);
      list.innerHTML = devices.map(device => `<li class="row wrap"><span class="grow"><strong>${esc(device.label)}</strong><small class="muted"> · pinned ${esc(when(device.pinnedAt))} · last seen ${esc(when(device.lastSeenAt))}</small></span><button type="button" class="compact" data-unpin="${esc(device.id)}" data-label="${esc(device.label)}">Unpin</button></li>`).join('')
        || '<li class="muted">No pinned device.</li>';
    } catch (error) {
      status.textContent = 'Family devices are unavailable right now.';
    }
  }

  host.querySelector('#familyDevicePin').addEventListener('submit', async event => {
    event.preventDefault();
    const label = host.querySelector('#familyDeviceLabel').value.trim() || 'Family device';
    if (!window.confirm(`Pin this device (“${label}”) to Famille? It will only open family pages until you unpin it from another device.`)) return;
    const button = event.submitter;
    if (button) button.disabled = true;
    try {
      await api('/api/household/family-device/pin', { method: 'POST', body: JSON.stringify({ label }) });
      window.location.assign('/panel');
    } catch (error) {
      status.textContent = error.message || 'This device could not be pinned.';
      if (button) button.disabled = false;
    }
  });

  list.addEventListener('click', async event => {
    const button = event.target.closest('[data-unpin]');
    if (!button) return;
    if (!window.confirm(`Unpin “${button.dataset.label}”? It will open every page again.`)) return;
    button.disabled = true;
    try {
      await api(`/api/household/family-devices/${encodeURIComponent(button.dataset.unpin)}`, { method: 'DELETE' });
      toast?.(`${button.dataset.label} unpinned.`);
      await refresh();
    } catch (error) {
      status.textContent = error.message || 'The device could not be unpinned.';
      button.disabled = false;
    }
  });

  refresh();
} };
