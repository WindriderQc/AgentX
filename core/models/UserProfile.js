'use strict';
const mongoose = require('mongoose');

/**
 * UserProfile — the Playground chat profile (about, custom instructions,
 * language, role, response style). AgentX has no user accounts: every request
 * runs as `default`, so in practice one document exists. Keying by userId keeps
 * the single-user identity documented in docs/ARCHITECTURE.md explicit.
 */
const PROFILE_LIMITS = Object.freeze({
  about: 8000,
  customInstructions: 4000,
  language: 100,
  role: 300,
  style: 1000
});

const UserProfileSchema = new mongoose.Schema({
  userId: { type: String, required: true, unique: true, trim: true },
  about: { type: String, default: '', maxlength: PROFILE_LIMITS.about },
  preferences: {
    customInstructions: { type: String, default: '', maxlength: PROFILE_LIMITS.customInstructions },
    language: { type: String, default: '', maxlength: PROFILE_LIMITS.language },
    role: { type: String, default: '', maxlength: PROFILE_LIMITS.role },
    style: { type: String, default: '', maxlength: PROFILE_LIMITS.style }
  }
}, { timestamps: true });

const UserProfile = mongoose.models.UserProfile || mongoose.model('UserProfile', UserProfileSchema);

module.exports = UserProfile;
module.exports.PROFILE_LIMITS = PROFILE_LIMITS;
