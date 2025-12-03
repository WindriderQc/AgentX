-- AgentX Database Schema
-- SQLite schema for conversation logging, user memory, and feedback

-- User profiles and memory
CREATE TABLE IF NOT EXISTS user_profiles (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL UNIQUE,
  name TEXT,
  role TEXT,
  language_preference TEXT DEFAULT 'en',
  response_style TEXT DEFAULT 'balanced', -- 'concise', 'detailed', 'balanced'
  code_preference TEXT DEFAULT 'balanced', -- 'code-heavy', 'conceptual', 'balanced'
  custom_preferences TEXT, -- JSON for extensibility
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Conversations (sessions/threads)
CREATE TABLE IF NOT EXISTS conversations (
  id TEXT PRIMARY KEY, -- UUID
  user_id TEXT NOT NULL,
  title TEXT,
  model TEXT NOT NULL,
  system_prompt TEXT,
  target TEXT, -- Ollama target host
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES user_profiles(user_id) ON DELETE CASCADE
);

-- Individual messages within conversations
CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY, -- UUID
  conversation_id TEXT NOT NULL,
  role TEXT NOT NULL, -- 'system', 'user', 'assistant'
  content TEXT NOT NULL,
  sequence_number INTEGER NOT NULL, -- Order within conversation
  timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE
);

-- Metadata for each LLM call (tied to assistant messages)
CREATE TABLE IF NOT EXISTS llm_metadata (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  message_id TEXT NOT NULL UNIQUE,
  model TEXT NOT NULL,
  temperature REAL,
  top_p REAL,
  top_k INTEGER,
  num_ctx INTEGER,
  tokens_prompt INTEGER,
  tokens_completion INTEGER,
  tokens_total INTEGER,
  latency_ms INTEGER, -- Response time in milliseconds
  options_json TEXT, -- Full options object as JSON
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (message_id) REFERENCES messages(id) ON DELETE CASCADE
);

-- User feedback on assistant responses
CREATE TABLE IF NOT EXISTS feedback (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  message_id TEXT NOT NULL,
  conversation_id TEXT NOT NULL,
  rating INTEGER, -- -1 (down), 0 (neutral), 1 (up)
  comment TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (message_id) REFERENCES messages(id) ON DELETE CASCADE,
  FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE
);

-- Indexes for performance
CREATE INDEX IF NOT EXISTS idx_conversations_user ON conversations(user_id);
CREATE INDEX IF NOT EXISTS idx_conversations_created ON conversations(created_at);
CREATE INDEX IF NOT EXISTS idx_messages_conversation ON messages(conversation_id);
CREATE INDEX IF NOT EXISTS idx_messages_sequence ON messages(conversation_id, sequence_number);
CREATE INDEX IF NOT EXISTS idx_feedback_message ON feedback(message_id);
CREATE INDEX IF NOT EXISTS idx_feedback_conversation ON feedback(conversation_id);
