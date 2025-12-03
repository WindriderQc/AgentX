const mongoose = require('mongoose');

const UserProfileSchema = new mongoose.Schema({
  userId: { type: String, unique: true, required: true, default: 'default' },
  name: { type: String, default: 'User' },
  about: { type: String, default: '' }, // "User Memory"
  preferences: {
    theme: { type: String, default: 'dark' },
    defaultModel: String,
    customInstructions: String
  },
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now }
});

UserProfileSchema.pre('save', function(next) {
  this.updatedAt = Date.now();
  next();
});

module.exports = mongoose.model('UserProfile', UserProfileSchema);
