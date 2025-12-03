// Helper to sanitize Ollama options
function sanitizeOptions(options = {}) {
  const numericKeys = [
    'temperature', 'top_k', 'top_p', 'num_ctx', 'repeat_penalty',
    'presence_penalty', 'frequency_penalty', 'seed', 'num_predict',
    'typical_p', 'tfs_z', 'mirostat', 'mirostat_eta', 'mirostat_tau'
  ];
  const clean = {};
  numericKeys.forEach((key) => {
    if (options[key] === 0 || options[key]) {
      const parsed = Number(options[key]);
      if (!Number.isNaN(parsed)) clean[key] = parsed;
    }
  });
  if (Array.isArray(options.stop)) clean.stop = options.stop;
  else if (typeof options.stop === 'string' && options.stop.trim()) {
    clean.stop = options.stop.split(',').map((val) => val.trim()).filter(Boolean);
  }
  if (options.keep_alive) clean.keep_alive = options.keep_alive;
  return clean;
}

// Resolve Ollama Target
function resolveTarget(target) {
    const fallback = 'http://localhost:11434';
    if (!target || typeof target !== 'string') return fallback;
    const trimmed = target.trim();
    if (!trimmed) return fallback;
    if (/^https?:\/\//i.test(trimmed)) return trimmed.replace(/\/+$/, '');
    return `http://${trimmed.replace(/\/+$/, '')}`;
}

module.exports = {
  sanitizeOptions,
  resolveTarget
};
