'use strict';

const path = require('node:path');
const MEDIA = /\.(jpe?g|jpe|jfif|png|gif|webp|heic|heif|avif|jxl|tiff?|bmp|dng|raw|cr2|cr3|nef|arw|rw2|orf|raf|mpo|mp4|mov|m4v|3gp|3gpp|avi|mkv|webm|mts|m2ts|xmp|aae)$/i;

function prefixBytes(header) {
  if (typeof header !== 'string' || header.length > 88 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(header)) return null;
  const bytes = Buffer.from(header, 'base64');
  return bytes.length <= 64 ? bytes : null;
}

function signatureExtension(header) {
  const b = prefixBytes(header);
  if (!b) return null;
  const hex = b.toString('hex'), text = b.toString('latin1');
  if (hex.startsWith('ffd8ff')) return '.jpg';
  if (hex.startsWith('89504e470d0a1a0a')) return '.png';
  if (/^GIF8[79]a/.test(text)) return '.gif';
  if (text.startsWith('RIFF') && text.slice(8, 12) === 'WEBP') return '.webp';
  if (hex.startsWith('49492a00') || hex.startsWith('4d4d002a') || hex.startsWith('49492b00') || hex.startsWith('4d4d002b')) return '.tiff';
  if (b.length >= 26 && text.startsWith('BM') && b.readUInt32LE(14) >= 12) return '.bmp';
  if (hex.startsWith('ff0a') || hex.startsWith('0000000c4a584c200d0a870a')) return '.jxl';
  if (b.length >= 12 && text.slice(4, 8) === 'ftyp') {
    const brands = [text.slice(8, 12)];
    for (let i = 16; i + 4 <= b.length; i += 4) brands.push(text.slice(i, i + 4));
    if (brands.some(x => ['avif', 'avis'].includes(x))) return '.avif';
    if (brands.some(x => ['heic', 'heix', 'hevc', 'hevx', 'heim', 'heis', 'mif1', 'msf1'].includes(x))) return '.heic';
    if (brands.includes('qt  ')) return '.mov';
    if (brands.some(x => ['isom', 'iso2', 'mp41', 'mp42', 'avc1', '3gp4', '3gp5'].includes(x))) return '.mp4';
  }
  return null;
}

const sourceExtension = item => MEDIA.test(item.name || '') ? path.extname(item.name).toLowerCase() : signatureExtension(item.header);

function classifyInventory(files, entries = []) {
  const prefixes = new Map(entries.map(e => [e.objectId, e]));
  const selected = [], errors = [];
  let unprobed = 0, signatureMatches = 0, nonMedia = 0;
  for (const item of files) {
    if (!Number.isSafeInteger(item.size) || item.size <= 0) {
      if (MEDIA.test(item.name || '')) errors.push({ key: item.key, reason: 'empty_or_invalid_media_size' });
      continue;
    }
    if (MEDIA.test(item.name || '')) { selected.push(item); continue; }
    const probe = prefixes.get(item.objectId);
    if (!probe) { unprobed++; continue; }
    if (probe.error || !prefixBytes(probe.header)?.length) { errors.push({ key: item.key, reason: probe.error || 'empty_or_invalid_prefix' }); continue; }
    const enriched = { ...item, header: probe.header };
    if (sourceExtension(enriched)) { selected.push(enriched); signatureMatches++; } else nonMedia++;
  }
  return { selected, errors, unprobed, signatureMatches, nonMedia, signatureAuditComplete: !unprobed && !errors.length };
}

module.exports = { MEDIA, prefixBytes, signatureExtension, sourceExtension, classifyInventory };
