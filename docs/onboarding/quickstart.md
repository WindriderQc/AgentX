# AgentX Quick Start Guide

## Prerequisites

1. **Node.js** (v18+ recommended)
2. **Ollama** (for LLM integration)

## Installation

```bash
# Clone/navigate to AgentX directory
cd /path/to/AgentX

# Install dependencies
npm install
```

## Starting the Server

```bash
npm start
```

Server starts on `http://localhost:3080`

## Testing the Backend

### Option 1: Automated Test Suite

```bash
./test-backend.sh
```

This will test all endpoints automatically.

### Option 2: Manual Testing

```bash
# 1. Health check
curl http://localhost:3080/health

# 2. Create user profile
curl -X POST http://localhost:3080/api/user/profile \
  -H "Content-Type: application/json" \
  -d '{
    "userId": "demo",
    "name": "Demo User",
    "role": "Developer",
    "response_style": "balanced",
    "code_preference": "balanced"
  }'

# 3. Start a chat (requires Ollama running)
curl -X POST http://localhost:3080/api/chat \
  -H "Content-Type: application/json" \
  -d '{
    "userId": "demo",
    "message": "What is recursion?",
    "model": "llama2"
  }'
```

## Setting Up Ollama

If you don't have Ollama:

```bash
# Install Ollama (macOS/Linux)
curl -fsSL https://ollama.ai/install.sh | sh

# Pull a model
ollama pull llama2

# Verify it's running
curl http://localhost:11434/api/tags
```

## Viewing the Database

The project uses MongoDB. You can inspect it using MongoDB Compass or the CLI.

```bash
# Connect to MongoDB
mongosh "mongodb://localhost:27017/agentx"

# View collections
show collections

# Query data
db.userprofiles.find()
db.conversations.find()
```

## Project Structure

```
AgentX/
├── server.js                  # Express server entry point
├── routes/                    # API route modules (chat, analytics, datasets, RAG)
├── models/                    # Persistence models (Mongoose)
├── config/                    # Database configuration and logger
├── docs/                      # Onboarding, architecture, API docs, reports, archive
├── specs/                     # Architecture specs for V3 RAG and V4 analytics
├── src/                       # Service utilities and middleware
├── public/                    # Frontend assets
├── test-backend.sh            # Backend test suite
├── test-v3-rag.sh             # RAG-specific validation
├── test-v4-analytics.sh       # Analytics and metrics validation
└── package.json               # Dependencies
```

## Common Issues

### "MongoDB connection failed"

Ensure MongoDB is running locally or `MONGODB_URI` is set correctly in `.env`.

### "Ollama connection failed"

Make sure Ollama is running:
```bash
# Check if Ollama is running
curl http://localhost:11434/api/tags

# If not, start it
ollama serve
```

### "Module not found"

Make sure you ran `npm install`:
```bash
npm install
```

## Next Steps

1. **Read the API documentation**: `../api/reference.md`
2. **Review the implementation**: `../reports/v4-implementation.md`
3. **Start building frontend**: Use endpoints from `../api/reference.md`
4. **Test with Postman**: Import endpoints as a collection

## Environment Variables

Optional configuration:

```bash
# Server port (default: 3080)
PORT=3080

# MongoDB Connection (default: mongodb://localhost:27017/agentx)
MONGODB_URI=mongodb://localhost:27017/agentx

# Start with custom settings
PORT=8080 MONGODB_URI=mongodb://localhost:27017/test_db npm start
```

## Development Workflow

1. **Make changes** to `server.js` or `models/`
2. **Restart server**: `npm start`
3. **Test changes**: `./test-backend.sh`
4. **Check database**: Use MongoDB Compass or `mongosh`

## API Base URL

All endpoints are available at:
```
http://localhost:3080/api/*
```

## Key Endpoints

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/health` | GET | Health check |
| `/api/chat` | POST | Enhanced chat with logging |
| `/api/user/profile` | GET/POST | User profile management |
| `/api/feedback` | POST | Submit feedback |
| `/api/conversations` | GET | List conversations |
| `/api/conversations/:id` | GET | Get conversation details |

See `../api/reference.md` for complete documentation.

## Support

- 📖 **Full API Docs**: `../api/reference.md`
- 🏗️ **Architecture**: `../architecture/backend-overview.md`
- 📊 **Implementation**: `../reports/v4-implementation.md`
- 🧪 **Testing**: `./test-backend.sh`

**Happy coding! 🚀**
