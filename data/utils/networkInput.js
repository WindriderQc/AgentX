'use strict';

// Validation of network values that reach an nmap command line or a Mongo
// filter. Data has no authentication: every caller on its interface is untrusted.

const IPV4_RE = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;
const MAC_RE = /^[0-9A-Fa-f]{2}([:-][0-9A-Fa-f]{2}){5}$/;

// A scan sweeps at most a /16 (65 536 addresses): a home LAN, never the internet.
const MIN_SCAN_PREFIX = 16;
const MAX_HOSTNAME_LENGTH = 253;
const MAX_VENDOR_LENGTH = 128;

function isIPv4(value) {
  if (typeof value !== 'string') return false;
  const match = IPV4_RE.exec(value);
  return !!match && match.slice(1).every(octet => Number(octet) <= 255);
}

/** An IPv4 address, or an IPv4 CIDR whose prefix is between /16 and /32. */
function isScanTarget(value) {
  if (typeof value !== 'string') return false;
  const [address, prefix, ...rest] = value.split('/');
  if (rest.length > 0 || !isIPv4(address)) return false;
  if (prefix === undefined) return true;
  return /^\d{1,2}$/.test(prefix) && Number(prefix) >= MIN_SCAN_PREFIX && Number(prefix) <= 32;
}

function boundedText(value, maxLength) {
  if (value === undefined || value === null) return '';
  if (typeof value !== 'string') return null;
  return value.slice(0, maxLength);
}

/**
 * One reported device as plain strings, or null when it cannot be stored:
 * `ip` must be an IPv4 string, `mac` empty or a MAC string, hostname and vendor
 * strings (cut to their maximum length). An object here would otherwise become
 * a Mongo operator in the upsert filter.
 */
function sanitizeDevice(device) {
  if (!device || typeof device !== 'object' || !isIPv4(device.ip)) return null;
  const mac = device.mac === undefined || device.mac === null ? '' : device.mac;
  if (mac !== '' && (typeof mac !== 'string' || !MAC_RE.test(mac))) return null;
  const hostname = boundedText(device.hostname, MAX_HOSTNAME_LENGTH);
  const vendor = boundedText(device.vendor, MAX_VENDOR_LENGTH);
  if (hostname === null || vendor === null) return null;
  return { ip: device.ip, mac, hostname, vendor };
}

module.exports = {
  MIN_SCAN_PREFIX, MAX_HOSTNAME_LENGTH, MAX_VENDOR_LENGTH,
  isIPv4, isScanTarget, sanitizeDevice
};
