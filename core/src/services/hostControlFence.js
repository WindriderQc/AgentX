'use strict';

// Host control lives in the runtime singleton so its fence and admission are
// changed atomically. Hostnames cover CPU/GPU ports; resource IDs cover aliases.
function hostname(host) {
  try { return new URL(host).hostname.toLowerCase(); } catch { return null; }
}

function matchingControl(controls, hosts, resourceIds = []) {
  const names = hosts.map(hostname).filter(Boolean);
  return (controls || []).find(item =>
    (item.hostnames || []).some(name => names.includes(name))
    || (item.resourceIds || []).some(id => resourceIds.includes(id)));
}

function pausedControl(controls, hosts, resourceIds = []) {
  return matchingControl((controls || []).filter(item => item.active), hosts, resourceIds);
}

function admitsHosts(hosts, resourceIds = []) {
  const overlap = hosts.length ? { $or: [
    { hostnames: { $in: hosts.map(hostname).filter(Boolean) } },
    { resourceIds: { $in: resourceIds } }
  ] } : {};
  return { hostControls: { $not: { $elemMatch: { active: true, ...overlap } } } };
}

function blocksHosts(controls, hosts, resourceIds = []) {
  return hosts.length ? pausedControl(controls, hosts, resourceIds) : (controls || []).find(item => item.active);
}

function observePausedHost(host, coordination, observeHost, failures) {
  if (!pausedControl(coordination.hostControls, [host.url])) return false;
  failures.set(host.url, 0);
  observeHost(host, { reason: 'host_control_paused' }, false);
  return true;
}

module.exports = { hostname, matchingControl, pausedControl, admitsHosts, blocksHosts, observePausedHost };
