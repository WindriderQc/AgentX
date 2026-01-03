/**
 * Test environment setup
 * Runs before each test file in the same environment context
 */

const mongoose = require('mongoose');
const connectDB = require('../config/db-mongodb');
const { MongoMemoryServer } = require('mongodb-memory-server');

let mongoServer;

// Set test environment
process.env.NODE_ENV = 'test';

// Connect to MongoDB before all tests
beforeAll(async () => {
  // Prefer in-memory MongoDB to avoid external dependency during tests
  if (!process.env.MONGODB_URI) {
    mongoServer = await MongoMemoryServer.create({
      binary: { version: '7.0.5' },
      instance: { dbName: 'agentx_test' }
    });
    process.env.MONGODB_URI = mongoServer.getUri();
  }

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

  if (mongoServer) {
    await mongoServer.stop();
    mongoServer = null;
  }
}, 30000); // 30 second timeout for teardown
