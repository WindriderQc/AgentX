const path = require('path');

const DEFAULT_POSIX_RAG_DIR = '/mnt/datalake/RAG';

function getDefaultRagDir() {
  if (process.platform === 'win32') {
    return path.join(process.cwd(), 'data', 'RAG');
  }

  return DEFAULT_POSIX_RAG_DIR;
}

function getConfiguredRagDir(rawValue = process.env.RAG_DIR) {
  const configured = String(rawValue || '').trim();
  return configured || getDefaultRagDir();
}

module.exports = {
  DEFAULT_POSIX_RAG_DIR,
  getDefaultRagDir,
  getConfiguredRagDir
};
