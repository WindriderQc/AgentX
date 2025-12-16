/**
 * User Helper Functions
 * Utilities to reduce code duplication for user-related operations
 */

const UserProfile = require('../../models/UserProfile');
const logger = require('../../config/logger');

/**
 * Extract userId from response locals with fallback to 'default'
 * @param {Object} res - Express response object
 * @returns {string} userId
 */
function getUserId(res) {
  return res.locals.user?._id?.toString() || res.locals.user?.userId || 'default';
}

/**
 * Get or create user profile
 * @param {string} userId - User ID
 * @returns {Promise<Object>} UserProfile document
 */
async function getOrCreateProfile(userId) {
  try {
    let profile = await UserProfile.findOne({ userId });
    if (!profile) {
      profile = await UserProfile.create({ userId });
      logger.info('Created new user profile', { userId });
    }
    return profile;
  } catch (err) {
    logger.error('Failed to get or create profile', { userId, error: err.message });
    // Return minimal profile on error
    return { userId, about: '', preferences: {} };
  }
}

module.exports = {
  getUserId,
  getOrCreateProfile
};
