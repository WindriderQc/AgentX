/**
 * Frontend Logger Utility
 * Provides conditional logging based on environment
 * Usage: import logger from '/js/utils/logger.js';
 *        logger.debug('Debug message');
 *        logger.error('Error message');
 */

const isDevelopment = window.location.hostname === 'localhost' || 
                      window.location.hostname === '127.0.0.1' ||
                      window.location.search.includes('debug=true');

const logger = {
  debug(...args) {
    if (isDevelopment) {
      console.log('[DEBUG]', ...args);
    }
  },
  
  log(...args) {
    if (isDevelopment) {
      console.log(...args);
    }
  },
  
  info(...args) {
    if (isDevelopment) {
      console.info('[INFO]', ...args);
    }
  },
  
  warn(...args) {
    // Always show warnings
    console.warn('[WARN]', ...args);
  },
  
  error(...args) {
    // Always show errors
    console.error('[ERROR]', ...args);
  },
  
  // For SSE events or important state changes - always log
  event(...args) {
    console.log('[EVENT]', ...args);
  }
};

// Make available globally
window.logger = logger;

export default logger;
