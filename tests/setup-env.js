/**
 * Test environment setup
 * Runs before each test file in the same environment context.
 */

const fs = require('fs');
const path = require('path');
const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');
const connectDB = require('../config/db-mongodb');
const { resetRagStore } = require('../src/services/ragStore');
const { resetEmbeddingsService } = require('../src/services/embeddings');
const { destroyAgents } = require('../src/helpers/httpAgent');

const mongoUriFile = path.join(__dirname, '.jest-mongo-uri');
const TEST_DB_STATE_KEY = Symbol.for('agentx.testDbState');
const DISCONNECT_IDLE_MS = Number(process.env.JEST_DB_IDLE_DISCONNECT_MS || 0);

function getTestDbState() {
  if (!process[TEST_DB_STATE_KEY]) {
    process[TEST_DB_STATE_KEY] = {
      connectPromise: null,
      disconnectTimer: null,
      mongoServer: null
    };
  }

  return process[TEST_DB_STATE_KEY];
}

function clearPendingDisconnect(state) {
  if (!state.disconnectTimer) return;

  clearTimeout(state.disconnectTimer);
  state.disconnectTimer = null;
}

function resolveWorkerMongoUri(state) {
  if (process.env.TEST_USE_EXTERNAL_MONGO === 'true') {
    return process.env.MONGODB_URI || null;
  }

  if (fs.existsSync(mongoUriFile)) {
    const baseUri = fs.readFileSync(mongoUriFile, 'utf8').trim().replace(/\/+$/, '');
    const workerId = process.env.JEST_WORKER_ID || '0';
    const uri = `${baseUri}/agentx_test_${workerId}`;
    process.env.MONGODB_URI = uri;
    return uri;
  }

  if (state.mongoServer) {
    const uri = state.mongoServer.getUri('agentx_test');
    process.env.MONGODB_URI = uri;
    return uri;
  }

  return null;
}

async function ensureMongoUri(state) {
  const uri = resolveWorkerMongoUri(state);
  if (uri || process.env.TEST_USE_EXTERNAL_MONGO === 'true') {
    return uri;
  }

  state.mongoServer = await MongoMemoryServer.create({
    instance: {
      dbName: 'agentx_test',
      launchTimeout: 30000
    }
  });

  const fallbackUri = state.mongoServer.getUri('agentx_test');
  process.env.MONGODB_URI = fallbackUri;
  return fallbackUri;
}

async function disconnectTestResources(state) {
  try {
    resetRagStore();
    resetEmbeddingsService();
    destroyAgents();
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn('⚠️ Warning: preventing test hang - Error resetting singleton services:', err.message);
  }

  try {
    if (mongoose.connection.readyState !== 0) {
      await mongoose.connection.close(true);
      // eslint-disable-next-line no-console
      console.log('✅ Test environment: MongoDB disconnected');
    }
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn('⚠️ Warning: preventing test hang - Error closing MongoDB:', err.message);
  }

  try {
    if (state.mongoServer) {
      await state.mongoServer.stop({ doCleanup: true, force: true });
      state.mongoServer = null;
    }
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn('⚠️ Warning: preventing test hang - Error stopping MongoMemoryServer:', err.message);
  }
}

function scheduleDisconnect(state) {
  clearPendingDisconnect(state);

  state.disconnectTimer = setTimeout(() => {
    state.disconnectTimer = null;
    void disconnectTestResources(state);
  }, DISCONNECT_IDLE_MS);

  if (typeof state.disconnectTimer.unref === 'function') {
    state.disconnectTimer.unref();
  }
}

process.env.NODE_ENV = 'test';

if (!process.env.OLLAMA_HOST) process.env.OLLAMA_HOST = 'http://127.0.0.1:11434';
if (!process.env.OLLAMA_HOST_SECONDARY && !process.env.OLLAMA_HOST_2) {
  process.env.OLLAMA_HOST_SECONDARY = 'http://127.0.0.1:11435';
}
if (!process.env.EMBEDDING_MODEL) process.env.EMBEDDING_MODEL = 'nomic-embed-text:v1.5';
if (!process.env.EMBEDDING_DIMENSION) process.env.EMBEDDING_DIMENSION = '768';

beforeAll(async () => {
  const state = getTestDbState();
  clearPendingDisconnect(state);

  if (!state.connectPromise) {
    state.connectPromise = (async () => {
      await ensureMongoUri(state);

      if (mongoose.connection.readyState === 1) {
        return;
      }

      if (mongoose.connection.readyState !== 0) {
        await mongoose.disconnect();
      }

      await connectDB();

      const { waitForConnection } = require('./helpers/dbHelper');
      await waitForConnection();

      // eslint-disable-next-line no-console
      console.log('✅ Test environment: MongoDB connected and ready');
    })().finally(() => {
      state.connectPromise = null;
    });
  }

  await state.connectPromise;
}, 30000);

afterAll(async () => {
  const state = getTestDbState();
  if (DISCONNECT_IDLE_MS > 0) {
    scheduleDisconnect(state);
    return;
  }

  clearPendingDisconnect(state);
  await disconnectTestResources(state);
});
