'use strict';

// Browser-facing management link only; credentials and login stay with Hermes.
function officialDashboardUrl(env = process.env) {
  const configured = env.HERMES_PUBLIC_URL || env.HERMES_DASHBOARD_URL;
  if (!configured) return null;
  try {
    const url = new URL(configured);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return null;
    url.hash = '';
    url.search = '';
    url.pathname = url.pathname.replace(/\/$/, '') + '/';
    url.searchParams.set('profile', 'imagex');
    return url.href;
  } catch { return null; }
}

module.exports = { officialDashboardUrl };
