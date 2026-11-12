'use strict';
const fs = require('node:fs'), path = require('node:path');
const { fail } = require('./importFiles');
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
function loadProcessingConfig(env = process.env) {
  if (!env.AGENTX_INSTANCE_ROOT) return null;
  const file = path.join(env.AGENTX_INSTANCE_ROOT, 'config/photo-import/processing.json');
  let value;
  try {
    if (fs.statSync(file).size > 8192) throw fail('PHOTO_PROCESSING_CONFIG_INVALID', 'Photo processing configuration is too large');
    value = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  if (value.version !== 1 || !/^[A-Za-z0-9][A-Za-z0-9_.@-]*$/.test(value.sshTarget || '')
    || !UUID.test(value.libraryId || '') || (value.frameAlbumId !== undefined && !UUID.test(value.frameAlbumId))
    || typeof value.originalPathPrefix !== 'string' || !value.originalPathPrefix.startsWith('/')
    || value.originalPathPrefix === '/' || path.posix.normalize(value.originalPathPrefix) !== value.originalPathPrefix
    || /[\\\x00-\x1f]/.test(value.originalPathPrefix) || value.originalPathPrefix.endsWith('/')
    || !/^https?:\/\//.test(value.nasHost || ''))
    throw fail('PHOTO_PROCESSING_CONFIG_INVALID', 'Invalid photo processing configuration');
  for (const name of ['identityFile', 'knownHostsFile']) {
    if (typeof value[name] !== 'string' || !path.isAbsolute(value[name]) || /[\r\n\0]/.test(value[name]))
      throw fail('PHOTO_PROCESSING_CONFIG_INVALID', 'Configure a pinned NAS identity');
  }
  return value;
}
module.exports = { loadProcessingConfig, UUID };
