/**
 * Test environment setup
 * Runs before each test file in the same environment context
 */

const mongoose = require('mongoose');
const connectDB = require('../config/db-mongodb');

// Set test environment
process.env.NODE_ENV = 'test';

// Use test database
if (!process.env.MONGODB_URI) {
  process.env.MONGODB_URI = 'mongodb://localhost:27017/agentx_test';
}

// Connect to MongoDB before all tests
beforeAll(async () => {
  // Only connect if not already connected
  if (mongoose.connection.readyState === 0) {
    await connectDB();
    console.log('✅ Test environment: MongoDB connected');
  }
}, 30000); // 30 second timeout for setup

// Close connection after all tests
afterAll(async () => {
  if (mongoose.connection.readyState !== 0) {
    await mongoose.connection.close();
    console.log('✅ Test environment: MongoDB disconnected');
  }
}, 30000); // 30 second timeout for teardown
