const mongoose = require('mongoose');
const logger = require('./logger');

const connectDB = async () => {
  try {
    const conn = await mongoose.connect(process.env.MONGO_URI || 'mongodb://localhost:27017/agentx', {
      serverSelectionTimeoutMS: 2000 // Fail fast if no DB
    });
    logger.info('MongoDB connected', { host: conn.connection.host, db: conn.connection.name });
    
    // V4: Initialize default PromptConfig if none exist
    await ensureDefaultPromptConfig();
  } catch (err) {
    logger.error('MongoDB connection failed', { error: err.message });
    // Don't kill the server if DB is missing, just log error for now to allow frontend verification
    // process.exit(1);
  }
};

/**
 * V4: Ensure at least one active PromptConfig exists
 * Contract: specs/V4_ANALYTICS_ARCHITECTURE.md § 1
 */
async function ensureDefaultPromptConfig() {
  try {
    const PromptConfig = require('../models/PromptConfig');
    
    const activePrompt = await PromptConfig.findOne({ name: 'default_chat', status: 'active' });
    
    if (!activePrompt) {
      logger.info('[V4] No active prompt found, creating default_chat v1');
      
      const defaultPrompt = new PromptConfig({
        name: 'default_chat',
        version: 1,
        systemPrompt: 'You are AgentX, a concise and capable local assistant. Keep answers brief and actionable.',
        description: 'Initial default system prompt',
        status: 'active',
        author: 'system'
      });
      
      await defaultPrompt.save();
      logger.info('[V4] Created default_chat v1', { status: 'active' });
    } else {
      logger.info('[V4] Active prompt loaded', { 
        name: activePrompt.name, 
        version: activePrompt.version 
      });
    }
  } catch (err) {
    logger.error('[V4] Failed to initialize PromptConfig', { error: err.message });
  }
}

module.exports = connectDB;
