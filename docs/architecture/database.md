# AgentX Database Architecture

## Overview

AgentX uses **MongoDB** as its database backend with Mongoose ODM.

## Configuration

### Environment Variable

Set `MONGO_URI` in your `.env` file:

```bash
MONGO_URI=mongodb://localhost:27017/agentx
```

## MongoDB Setup

### Installation

```bash
# Ubuntu/Debian
sudo apt install mongodb

# macOS
brew install mongodb-community

# Or use MongoDB Atlas (cloud)
# https://www.mongodb.com/cloud/atlas
```

### Starting MongoDB

```bash
# Linux
sudo systemctl start mongodb

# macOS
brew services start mongodb-community
```

### Configuration

```bash
# Local MongoDB
MONGO_URI=mongodb://localhost:27017/agentx

# MongoDB Atlas (cloud)
MONGO_URI=mongodb+srv://user:pass@cluster.mongodb.net/agentx?retryWrites=true&w=majority
```

### Features

- Production-ready and scalable
- Rich querying capabilities
- Multi-user deployments
- Cloud-ready (MongoDB Atlas)
- Flexible schema evolution
- Connection pooling (10-50 connections)
- Automatic reconnection

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

## API Endpoints

```bash
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

## Database Backup

### Using mongodump
```bash
# Backup all data
mongodump --db agentx --out ./backup

# Restore from backup
mongorestore --db agentx ./backup/agentx
```

### MongoDB Atlas Backups
MongoDB Atlas provides automatic continuous backups with point-in-time recovery.

## Development vs Production

### Development (Local MongoDB)
```bash
MONGO_URI=mongodb://localhost:27017/agentx
```

### Production (MongoDB Atlas or Remote)
```bash
MONGO_URI=mongodb+srv://username:password@cluster.mongodb.net/agentx?retryWrites=true&w=majority
```

## Architecture

```
server.js
    ↓
config/db.js
    ↓
config/db-mongodb.js (Mongoose connection)
    ↓
Models (Mongoose schemas)
    ├─→ models/Conversation.js
    ├─→ models/UserProfile.js
    └─→ models/PromptConfig.js
```

## Implementation Details

- **ORM**: Mongoose (MongoDB object modeling)
- **Connection Pooling**: 10-50 connections
- **Models**: Conversation, UserProfile, PromptConfig, Feedback
- **Async/await**: All database operations use async/await
- **Indexes**: Optimized for common queries (userId, timestamps)

## Performance Optimizations

- Connection pooling (maxPoolSize: 50, minPoolSize: 10)
- Lean queries for read-only operations
- Selective field projection
- Index-backed queries
- Query monitoring and slow query detection

## Testing

```bash
npm test
```

## Monitoring

- Query performance tracking in `src/utils/queryOptimizer.js`
- Slow query detection (>1s)
- Connection health checks
- Error logging with Winston
