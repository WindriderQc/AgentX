'use strict';
/**
 * User Helper Functions
 *
 * AgentX has no user accounts: every request runs as 'default' (see
 * docs/ARCHITECTURE.md). The chat profile of that identity is stored in
 * MongoDB (models/UserProfile) so it survives a restart.
 */

const UserProfile = require('../../models/UserProfile');

const PREFERENCE_FIELDS = Object.freeze(['customInstructions', 'language', 'role', 'style']);

/**
 * Extract userId from response locals with fallback to 'default'
 * @param {Object} res - Express response object
 * @returns {string} userId
 */
function getUserId(res) {
    return res.locals?.user?._id?.toString()
        || res.locals?.user?.userId
        || 'default';
}

function toPlainProfile(doc, userId) {
    const preferences = doc?.preferences || {};
    return {
        userId: doc?.userId || userId,
        about: doc?.about || '',
        preferences: Object.fromEntries(PREFERENCE_FIELDS.map(field => [field, preferences[field] || '']))
    };
}

async function upsertProfile(userId, update) {
    const run = () => UserProfile.findOneAndUpdate(
        { userId },
        { ...update, $setOnInsert: { userId } },
        { upsert: true, new: true, runValidators: true, setDefaultsOnInsert: true }
    ).lean();
    try {
        return await run();
    } catch (err) {
        // Two concurrent first-time upserts race on the unique userId index;
        // the loser retries against the document the winner created.
        if (err && err.code === 11000) return run();
        throw err;
    }
}

/**
 * Load the stored profile; an empty profile is returned (not written) until
 * the first save, so chat turns never write here.
 * @param {string} userId
 * @returns {Promise<{userId: string, about: string, preferences: Object}>}
 */
async function getOrCreateProfile(userId) {
    const resolvedUserId = userId || 'default';
    const doc = await UserProfile.findOne({ userId: resolvedUserId }).lean();
    return toPlainProfile(doc, resolvedUserId);
}

/**
 * Persist the provided profile fields; omitted fields keep their stored value.
 * Callers validate types and lengths (routes/profile.js).
 * @param {string} userId
 * @param {{about?: string, preferences?: Object}} profile
 */
async function saveProfile(userId, profile = {}) {
    const resolvedUserId = userId || 'default';
    const $set = {};
    if (typeof profile.about === 'string') $set.about = profile.about;
    const preferences = profile.preferences || {};
    for (const field of PREFERENCE_FIELDS) {
        if (typeof preferences[field] === 'string') $set[`preferences.${field}`] = preferences[field];
    }
    const doc = await upsertProfile(resolvedUserId, Object.keys($set).length ? { $set } : {});
    return toPlainProfile(doc, resolvedUserId);
}

module.exports = { getUserId, getOrCreateProfile, saveProfile, PREFERENCE_FIELDS };
