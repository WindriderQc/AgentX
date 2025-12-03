/**
 * AgentX Database Module
 * SQLite database initialization and access layer
 */

const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const fs = require('fs');
const { randomUUID } = require('crypto');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'data', 'agentx.db');
const SCHEMA_PATH = path.join(__dirname, 'schema.sql');

let db = null;

/**
 * Initialize the database connection and schema
 */
function initDatabase() {
  return new Promise((resolve, reject) => {
    // Ensure data directory exists
    const dataDir = path.dirname(DB_PATH);
    if (!fs.existsSync(dataDir)) {
      fs.mkdirSync(dataDir, { recursive: true });
    }

    // Open database connection
    db = new sqlite3.Database(DB_PATH, (err) => {
      if (err) {
        console.error('Database connection error:', err);
        return reject(err);
      }

      // Load and execute schema
      const schema = fs.readFileSync(SCHEMA_PATH, 'utf8');
      db.exec(schema, (err) => {
        if (err) {
          console.error('Schema initialization error:', err);
          return reject(err);
        }
        console.log(`Database initialized at ${DB_PATH}`);
        resolve(db);
      });
    });
  });
}

/**
 * Get the database instance
 */
function getDb() {
  if (!db) {
    throw new Error('Database not initialized. Call initDatabase() first.');
  }
  return db;
}

/**
 * Close database connection
 */
function closeDatabase() {
  if (db) {
    db.close();
    db = null;
  }
}

// Helper: Promisify db.get
function dbGet(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => {
      if (err) reject(err);
      else resolve(row);
    });
  });
}

// Helper: Promisify db.all
function dbAll(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => {
      if (err) reject(err);
      else resolve(rows);
    });
  });
}

// Helper: Promisify db.run
function dbRun(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function (err) {
      if (err) reject(err);
      else resolve(this);
    });
  });
}

// ========== USER PROFILE OPERATIONS ==========

/**
 * Get or create user profile
 * @param {string} userId - User identifier
 * @returns {object} User profile
 */
async function getOrCreateUserProfile(userId) {
  getDb();
  
  let profile = await dbGet('SELECT * FROM user_profiles WHERE user_id = ?', [userId]);
  
  if (!profile) {
    // Create default profile
    await dbRun(
      `INSERT INTO user_profiles (user_id, name, language_preference, response_style, code_preference)
       VALUES (?, ?, ?, ?, ?)`,
      [userId, 'User', 'en', 'balanced', 'balanced']
    );
    profile = await dbGet('SELECT * FROM user_profiles WHERE user_id = ?', [userId]);
  }
  
  return profile;
}

/**
 * Update user profile
 * @param {string} userId - User identifier
 * @param {object} updates - Fields to update
 * @returns {object} Updated profile
 */
async function updateUserProfile(userId, updates) {
  getDb();
  
  const allowedFields = ['name', 'role', 'language_preference', 'response_style', 'code_preference', 'custom_preferences'];
  const setFields = [];
  const values = [];
  
  Object.keys(updates).forEach(key => {
    if (allowedFields.includes(key) && updates[key] !== undefined) {
      setFields.push(`${key} = ?`);
      values.push(typeof updates[key] === 'object' ? JSON.stringify(updates[key]) : updates[key]);
    }
  });
  
  if (setFields.length === 0) {
    return await getOrCreateUserProfile(userId);
  }
  
  setFields.push('updated_at = CURRENT_TIMESTAMP');
  values.push(userId);
  
  const sql = `UPDATE user_profiles SET ${setFields.join(', ')} WHERE user_id = ?`;
  await dbRun(sql, values);
  
  return await getOrCreateUserProfile(userId);
}

// ========== CONVERSATION OPERATIONS ==========

/**
 * Create a new conversation
 * @param {object} data - Conversation data
 * @returns {object} Created conversation
 */
async function createConversation(data) {
  getDb();
  const id = data.id || randomUUID();
  
  await dbRun(
    `INSERT INTO conversations (id, user_id, title, model, system_prompt, target)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [
      id,
      data.user_id || 'default',
      data.title || 'New Conversation',
      data.model,
      data.system_prompt || null,
      data.target || 'localhost:11434'
    ]
  );
  
  return await dbGet('SELECT * FROM conversations WHERE id = ?', [id]);
}

/**
 * Get conversation by ID
 * @param {string} conversationId - Conversation UUID
 * @returns {object|null} Conversation or null
 */
async function getConversation(conversationId) {
  getDb();
  return await dbGet('SELECT * FROM conversations WHERE id = ?', [conversationId]);
}

/**
 * Get conversations for a user
 * @param {string} userId - User identifier
 * @param {number} limit - Max results (default 50)
 * @returns {array} Array of conversations
 */
async function getUserConversations(userId, limit = 50) {
  getDb();
  return await dbAll(
    `SELECT * FROM conversations 
     WHERE user_id = ? 
     ORDER BY updated_at DESC 
     LIMIT ?`,
    [userId, limit]
  );
}

/**
 * Update conversation timestamp
 * @param {string} conversationId - Conversation UUID
 */
async function touchConversation(conversationId) {
  getDb();
  await dbRun('UPDATE conversations SET updated_at = CURRENT_TIMESTAMP WHERE id = ?', [conversationId]);
}

/**
 * Update conversation title
 * @param {string} conversationId - Conversation UUID
 * @param {string} title - New title
 */
async function updateConversationTitle(conversationId, title) {
  getDb();
  await dbRun('UPDATE conversations SET title = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?', [title, conversationId]);
}

// ========== MESSAGE OPERATIONS ==========

/**
 * Add a message to a conversation
 * @param {object} data - Message data
 * @returns {object} Created message
 */
async function createMessage(data) {
  getDb();
  const id = data.id || randomUUID();
  
  // Get next sequence number
  const maxSeq = await dbGet(
    'SELECT MAX(sequence_number) as max FROM messages WHERE conversation_id = ?',
    [data.conversation_id]
  );
  const sequenceNumber = (maxSeq?.max || 0) + 1;
  
  await dbRun(
    `INSERT INTO messages (id, conversation_id, role, content, sequence_number)
     VALUES (?, ?, ?, ?, ?)`,
    [id, data.conversation_id, data.role, data.content, sequenceNumber]
  );
  
  return await dbGet('SELECT * FROM messages WHERE id = ?', [id]);
}

/**
 * Get all messages in a conversation
 * @param {string} conversationId - Conversation UUID
 * @returns {array} Array of messages ordered by sequence
 */
async function getConversationMessages(conversationId) {
  getDb();
  return await dbAll(
    `SELECT m.*, l.model, l.temperature, l.tokens_total, l.latency_ms
     FROM messages m
     LEFT JOIN llm_metadata l ON m.id = l.message_id
     WHERE m.conversation_id = ?
     ORDER BY m.sequence_number ASC`,
    [conversationId]
  );
}

/**
 * Get a single message by ID
 * @param {string} messageId - Message UUID
 * @returns {object|null} Message or null
 */
async function getMessage(messageId) {
  getDb();
  return await dbGet('SELECT * FROM messages WHERE id = ?', [messageId]);
}

// ========== LLM METADATA OPERATIONS ==========

/**
 * Store LLM metadata for an assistant message
 * @param {object} data - Metadata
 */
async function createLLMMetadata(data) {
  getDb();
  
  await dbRun(
    `INSERT INTO llm_metadata (
       message_id, model, temperature, top_p, top_k, num_ctx,
       tokens_prompt, tokens_completion, tokens_total, latency_ms, options_json
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      data.message_id,
      data.model,
      data.temperature || null,
      data.top_p || null,
      data.top_k || null,
      data.num_ctx || null,
      data.tokens_prompt || null,
      data.tokens_completion || null,
      data.tokens_total || null,
      data.latency_ms || null,
      data.options_json ? JSON.stringify(data.options_json) : null
    ]
  );
}

/**
 * Get LLM metadata for a message
 * @param {string} messageId - Message UUID
 * @returns {object|null} Metadata or null
 */
async function getLLMMetadata(messageId) {
  getDb();
  return await dbGet('SELECT * FROM llm_metadata WHERE message_id = ?', [messageId]);
}

// ========== FEEDBACK OPERATIONS ==========

/**
 * Create feedback for a message
 * @param {object} data - Feedback data
 * @returns {object} Created feedback
 */
async function createFeedback(data) {
  getDb();
  
  // Verify message exists and get its conversation
  const message = await getMessage(data.message_id);
  if (!message) {
    throw new Error('Message not found');
  }
  
  const result = await dbRun(
    `INSERT INTO feedback (message_id, conversation_id, rating, comment)
     VALUES (?, ?, ?, ?)`,
    [
      data.message_id,
      message.conversation_id,
      data.rating,
      data.comment || null
    ]
  );
  
  return await dbGet('SELECT * FROM feedback WHERE id = ?', [result.lastID]);
}

/**
 * Get feedback for a message
 * @param {string} messageId - Message UUID
 * @returns {array} Array of feedback entries
 */
async function getMessageFeedback(messageId) {
  getDb();
  return await dbAll('SELECT * FROM feedback WHERE message_id = ?', [messageId]);
}

/**
 * Get all feedback for a conversation
 * @param {string} conversationId - Conversation UUID
 * @returns {array} Array of feedback entries
 */
async function getConversationFeedback(conversationId) {
  getDb();
  return await dbAll('SELECT * FROM feedback WHERE conversation_id = ?', [conversationId]);
}

// ========== UTILITY FUNCTIONS ==========

/**
 * Get conversation with full context (messages, metadata, feedback)
 * @param {string} conversationId - Conversation UUID
 * @returns {object} Full conversation object
 */
async function getFullConversation(conversationId) {
  const conversation = await getConversation(conversationId);
  if (!conversation) {
    return null;
  }
  
  const messages = await getConversationMessages(conversationId);
  const feedback = await getConversationFeedback(conversationId);
  
  return {
    ...conversation,
    messages,
    feedback
  };
}

module.exports = {
  initDatabase,
  getDb,
  closeDatabase,
  
  // User profile
  getOrCreateUserProfile,
  updateUserProfile,
  
  // Conversations
  createConversation,
  getConversation,
  getUserConversations,
  touchConversation,
  updateConversationTitle,
  
  // Messages
  createMessage,
  getConversationMessages,
  getMessage,
  
  // LLM metadata
  createLLMMetadata,
  getLLMMetadata,
  
  // Feedback
  createFeedback,
  getMessageFeedback,
  getConversationFeedback,
  
  // Utility
  getFullConversation
};
