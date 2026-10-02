'use strict';

function normalizedPath(file = {}) {
  return String(file.relativePath || file.relative_path || file.path || '')
    .replace(/\\/g, '/')
    .replace(/\/+/g, '/')
    .toLowerCase();
}

function normalizedExtension(file = {}) {
  return String(file.extension || file.ext || '')
    .toLowerCase()
    .replace(/^\./, '');
}

function normalizedFilename(file = {}) {
  const direct = String(file.filename || '').trim();
  if (direct) return direct.replace(/\\/g, '/').split('/').pop().toLowerCase();
  return normalizedPath(file).split('/').pop() || '';
}

module.exports = {
  normalizedPath,
  normalizedExtension,
  normalizedFilename
};
