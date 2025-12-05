const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');

const UserProfileSchema = new mongoose.Schema({
  userId: { type: String, unique: true, required: true, default: 'default' },
  name: { type: String, default: 'User' },
  email: { type: String, unique: true, sparse: true }, // Optional for backward compatibility
  password: { type: String }, // Hashed password
  isAdmin: { type: Boolean, default: false },
  about: { type: String, default: '' }, // "User Memory"
  preferences: {
    theme: { type: String, default: 'dark' },
    defaultModel: String,
    customInstructions: String
  },
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now },
  lastLogin: { type: Date }
});

// Hash password before saving
UserProfileSchema.pre('save', async function() {
  this.updatedAt = Date.now();
  
  // Only hash password if it's modified and exists
  if (this.isModified('password') && this.password) {
    const salt = await bcrypt.genSalt(10);
    this.password = await bcrypt.hash(this.password, salt);
  }
});

// Method to compare password
UserProfileSchema.methods.comparePassword = async function(candidatePassword) {
  if (!this.password) return false;
  return bcrypt.compare(candidatePassword, this.password);
};

module.exports = mongoose.model('UserProfile', UserProfileSchema);
