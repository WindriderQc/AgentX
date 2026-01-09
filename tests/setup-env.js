/**
 * Test environment setup
 * Runs before each test file in the same environment context
 */

const mongoose = require('mongoose');
const connectDB = require('../config/db-mongodb');
const { MongoMemoryServer } = require('mongodb-memory-server');
const fs = require('fs');
const path = require('path');

let mongoServer;
const mongoUriFile = path.join(__dirname, '.jest-mongo-uri');

// Set test environment
process.env.NODE_ENV = 'test';

// Ensure deterministic ModelRouter host configuration for unit/integration tests.
// These are only defaults for tests; production should set real hosts.
if (!process.env.OLLAMA_HOST) process.env.OLLAMA_HOST = 'http://127.0.0.1:11434';
if (!process.env.OLLAMA_HOST_SECONDARY && !process.env.OLLAMA_HOST_2) {
  process.env.OLLAMA_HOST_SECONDARY = 'http://127.0.0.1:11435';
}

// Connect to MongoDB before all tests
beforeAll(async () => {
  // Use in-memory MongoDB for deterministic, isolated tests.
  // Opt out only if explicitly requested.
  const useExternalMongo = process.env.TEST_USE_EXTERNAL_MONGO === 'true';
  if (!useExternalMongo) {
    // Prefer the shared MongoMemoryServer started by Jest globalSetup.
    // Fallback to per-process server when running a single file outside Jest global setup.
    if (fs.existsSync(mongoUriFile)) {
      const baseUri = fs.readFileSync(mongoUriFile, 'utf8').trim().replace(/\/+$/, '');
      const workerId = process.env.JEST_WORKER_ID || '0';
      const dbName = `agentx_test_${workerId}`;
      process.env.MONGODB_URI = `${baseUri}/${dbName}`;
    } else {
      mongoServer = await MongoMemoryServer.create({
        instance: {
          dbName: 'agentx_test',
          launchTimeout: 30000
        }
      });

      process.env.MONGODB_URI = mongoServer.getUri('agentx_test');
    }
  }

  // Only connect if not already connected
  if (mongoose.connection.readyState === 0) {
    await connectDB();

    // Wait for connection to be fully ready
    const { waitForConnection } = require('./helpers/dbHelper');
    await waitForConnection();

    console.log('✅ Test environment: MongoDB connected and ready');
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
