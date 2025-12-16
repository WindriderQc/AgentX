/**
 * Authentication Middleware for AgentX
 * 
 * Self-contained authentication system with:
 * - Session-based auth for web/API users
 * - API key auth for programmatic access (n8n, automation)
 * - Role-based access control
 */

const logger = require('../../config/logger');

/**
 * Attach user to res.locals from session
 * Runs on every request, never blocks
 */
const attachUser = async (req, res, next) => {
  res.locals.user = null;
  
  if (req.session && req.session.userId) {
    try {
      const UserProfile = require('../../models/UserProfile');
      const user = await UserProfile.findById(req.session.userId);
      
      if (user) {
        res.locals.user = {
          _id: user._id,
          userId: user.userId,
          name: user.name,
          email: user.email,
          isAdmin: user.isAdmin || false
        };
        logger.debug(`User attached: ${user.email}`);
      } else {
        logger.warn(`Session userId ${req.session.userId} not found in database`);
      }
    } catch (error) {
      logger.error('Error attaching user:', error);
    }
  }
  
  next();
};

/**
 * Require authentication - blocks unauthenticated requests
 */
const requireAuth = (req, res, next) => {
  if (!res.locals.user) {
    logger.warn(`Unauthorized access attempt: ${req.method} ${req.originalUrl}`);
    return res.status(401).json({ 
      status: 'error', 
      message: 'Authentication required' 
    });
  }
  next();
};

/**
 * Require admin role
 */
const requireAdmin = (req, res, next) => {
  if (!res.locals.user || !res.locals.user.isAdmin) {
    logger.warn(`Admin access denied: ${req.method} ${req.originalUrl}`);
    return res.status(403).json({ 
      status: 'error', 
      message: 'Admin access required' 
    });
  }
  next();
};

/**
 * API Key authentication for automation/n8n
 * Checks x-api-key header against environment variable
 */
const apiKeyAuth = (req, res, next) => {
  const apiKey = req.header('x-api-key');
  const validKey = process.env.AGENTX_API_KEY;
  
  if (!validKey) {
    logger.error('AGENTX_API_KEY not configured in environment');
    return res.status(500).json({ 
      status: 'error', 
      message: 'API key authentication not configured' 
    });
  }
  
  if (!apiKey || apiKey !== validKey) {
    logger.warn(`Invalid API key attempt from ${req.ip}`);
    return res.status(401).json({ 
      status: 'error', 
      message: 'Invalid or missing API key' 
    });
  }
  
  // Tag request as API-authenticated
  req.authSource = 'api-key';
  logger.debug(`API key authenticated: ${req.method} ${req.originalUrl}`);
  next();
};

/**
 * Optional auth - allows both session and API key
 * Useful for endpoints that enhance functionality when authenticated
 */
const optionalAuth = async (req, res, next) => {
  // Try session auth first
  await attachUser(req, res, () => {});
  
  // If no session user, try API key
  if (!res.locals.user) {
    const apiKey = req.header('x-api-key');
    if (apiKey === process.env.AGENTX_API_KEY) {
      req.authSource = 'api-key';
      res.locals.user = { userId: 'api-client', name: 'API Client' };
    }
  }
  
  next();
};

module.exports = {
  attachUser,
  requireAuth,
  requireAdmin,
  apiKeyAuth,
  optionalAuth
};
