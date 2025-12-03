# AgentX Dual Database Architecture

## Overview

AgentX supports **two database backends**, selectable via environment variable:

1. **MongoDB** (default) - Full-featured, production-ready, scalable
2. **SQLite** - Lightweight, zero-configuration, portable

## Configuration

### Environment Variable

Set `DB_TYPE` in your `.env` file:

```bash
# Use MongoDB (default)
DB_TYPE=mongodb
MONGO_URI=mongodb://localhost:27017/agentx

# OR use SQLite
DB_TYPE=sqlite
SQLITE_PATH=./agentx.db
```

## Database Comparison

### MongoDB (Agent A's Implementation)

**Pros:**
- Production-ready and scalable
- Rich querying capabilities
- Better for multi-user deployments
- Cloud-ready (MongoDB Atlas)
- Flexible schema evolution

**Cons:**
- Requires MongoDB server installation
- Higher memory footprint
- More complex setup

**Usage:**
```bash
# Install MongoDB
sudo apt install mongodb  # Ubuntu/Debian
brew install mongodb-community  # macOS

# Start MongoDB
sudo systemctl start mongodb  # Linux
brew services start mongodb-community  # macOS

# Configure AgentX
echo "DB_TYPE=mongodb" > .env
echo "MONGO_URI=mongodb://localhost:27017/agentx" >> .env

npm start
```

### SQLite (Agent B's Implementation)

**Pros:**
- Zero configuration required
- No separate server needed
- Single file database
- Perfect for local/development use
- Portable and lightweight

**Cons:**
- Limited concurrency
- Not ideal for multi-user production
- Simpler query capabilities

**Usage:**
```bash
# No installation needed! Just configure:
echo "DB_TYPE=sqlite" > .env
echo "SQLITE_PATH=./agentx.db" >> .env

npm start
```

## Data Models

Both implementations provide identical API surfaces:

### Conversations
- Stores chat history
- Links to messages
- Tracks model and system prompts

### Messages
- User and assistant messages
- Timestamps and sequence numbers
- LLM metadata (tokens, latency)

### User Profiles
- User preferences
- Memory/context injection
- Response style settings

### Feedback
- Message ratings (thumbs up/down)
- Comments and improvement notes

## API Compatibility

All endpoints work identically regardless of database backend:

```bash
# These work with both MongoDB and SQLite:
POST   /api/chat
GET    /api/conversations
GET    /api/conversations/:id
PATCH  /api/conversations/:id
GET    /api/user/profile
POST   /api/user/profile
POST   /api/feedback
GET    /api/feedback/message/:messageId
GET    /api/feedback/conversation/:conversationId
```

## Switching Databases

**Important:** Switching databases will create a fresh database. Data is NOT automatically migrated between MongoDB and SQLite.

### From MongoDB to SQLite:
```bash
# 1. Backup your MongoDB data
mongodump --db agentx --out ./backup

# 2. Switch to SQLite
sed -i 's/DB_TYPE=mongodb/DB_TYPE=sqlite/' .env

# 3. Restart server (creates new SQLite database)
npm start
```

### From SQLite to MongoDB:
```bash
# 1. Backup your SQLite database
cp agentx.db agentx.db.backup

# 2. Switch to MongoDB
sed -i 's/DB_TYPE=sqlite/DB_TYPE=mongodb/' .env

# 3. Restart server (connects to MongoDB)
npm start
```

## Development vs Production

### Development (Recommended: SQLite)
```bash
DB_TYPE=sqlite
SQLITE_PATH=./agentx.dev.db
```

### Production (Recommended: MongoDB)
```bash
DB_TYPE=mongodb
MONGO_URI=mongodb://username:password@production-host:27017/agentx?authSource=admin
```

## Architecture

```
server.js
    ↓
config/db.js (Router)
    ↓
    ├─→ config/db-mongodb.js (Mongoose models)
    └─→ config/db-sqlite.js (SQLite async wrapper)
```

## Implementation Details

### MongoDB Implementation (Agent A)
- Uses Mongoose ODM
- Models in `models/Conversation.js` and `models/UserProfile.js`
- Async/await with Mongoose queries

### SQLite Implementation (Agent B)
- Uses sqlite3 with promisified wrapper
- Schema in `schema.sql`
- Manual JOIN queries for relationships
- Full transaction support

## Testing

```bash
# Test with MongoDB
DB_TYPE=mongodb npm test

# Test with SQLite
DB_TYPE=sqlite npm test
```

## Migration Script (Future Enhancement)

A data migration tool between MongoDB ↔ SQLite is planned for v3.0.

## Contributors

- **Agent A**: MongoDB/Mongoose implementation
- **Agent B**: SQLite implementation and dual-database architecture
