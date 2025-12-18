const logger = require('../../config/logger');

/**
 * n8n Authentication Middleware
 * 
 * Authenticates requests from n8n workflows using API key header.
 * Optionally restricts access to LAN-only requests for additional security.
 * 
 * Usage:
 * - Add x-api-key header to n8n HTTP Request nodes
 * - Set N8N_API_KEY environment variable on the server
 * - Optionally set N8N_LAN_ONLY=true to restrict to local network
 */

/**
 * Check if request originates from local network
 * @param {Object} req - Express request object
 * @returns {boolean} - True if request is from LAN
 */
function fromLan(req) {
  const allowed = ['192.168.', '10.', '172.16.', '127.0.0.1', '::1', 'localhost'];
  const ip = req.ip || req.connection?.remoteAddress || req.socket?.remoteAddress || '';
  
  // Extract IPv4 from IPv6-mapped address (e.g., ::ffff:192.168.1.1)
  const cleanIp = ip.replace(/^::ffff:/, '');
  
  return allowed.some(prefix => cleanIp.startsWith(prefix));
}

/**
 * Middleware to authenticate n8n requests via API key header OR browser session OR LAN access
 * @param {Object} req - Express request object
 * @param {Object} res - Express response object
 * @param {Function} next - Express next middleware function
 */
function n8nAuth(req, res, next) {
  const key = req.header('x-api-key');
  const expected = process.env.N8N_API_KEY;

  // Check if LAN-only mode is enabled
  const lanOnly = process.env.N8N_LAN_ONLY === 'true';
  
  // If from LAN, allow access without authentication (trusted network)
  if (fromLan(req)) {
    req.isN8N = false;
    req.authSource = 'lan';
    if (process.env.NODE_ENV !== 'test') {
      logger.info(`n8n endpoint accessed from LAN: ${req.method} ${req.originalUrl} from ${req.ip}`);
    }
    return next();
  }
  
  // If not from LAN and LAN-only mode is enabled, reject
  if (lanOnly) {
    logger.warn(`n8n auth rejected: Request from non-LAN IP ${req.ip}`);
    return res.status(403).json({ 
      status: 'error',
      message: 'Forbidden: LAN access only' 
    });
  }

  // Check for valid browser session (for external frontend requests)
  if (req.session && req.session.userId) {
    req.isN8N = false;
    req.authSource = 'session';
    logger.info(`n8n endpoint accessed by authenticated user: ${req.method} ${req.originalUrl}`);
    return next();
  }

  // Check for API key (for server-to-server n8n webhooks from external sources)
  if (!expected) {
    logger.error('n8n auth error: N8N_API_KEY environment variable not set');
    return res.status(500).json({ 
      status: 'error',
      message: 'Server configuration error' 
    });
  }

  if (!key || key !== expected) {
    logger.warn(`n8n auth failed: No LAN, no session, invalid/missing API key from ${req.ip}`);
    return res.status(401).json({ 
      status: 'error',
      message: 'Unauthorized: Please login, access from LAN, or provide valid API key' 
    });
  }

  // Tag the request as coming from n8n for downstream middleware
  req.isN8N = true;
  req.authSource = 'n8n';
  
  // Log successful n8n authentication
  if (process.env.NODE_ENV !== 'test') {
    logger.info(`n8n authenticated request: ${req.method} ${req.originalUrl} from ${req.ip}`);
  }
  
  next();
}

module.exports = n8nAuth;
