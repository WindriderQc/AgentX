# Getting Started Section (Archived from CLAUDE.md)

**Archived:** 2026-01-04
**Reason:** Duplicates content in `/docs/onboarding/quickstart.md`
**Original Location:** CLAUDE.md lines 17-94

---

## Getting Started

### Initial Setup

1. **Clone the repository**:
   ```bash
   git clone https://github.com/WindriderQc/AgentX.git
   cd AgentX
   ```

2. **Install dependencies**:
   ```bash
   npm install
   ```

3. **Configure Environment**:
   - Copy `.env.example` to `.env` (if available) or create `.env` with these key variables:
   ```bash
   MONGODB_URI=mongodb://192.168.2.33:27017/agentx
   OLLAMA_HOST=http://192.168.2.99:11434
   PORT=3080
   VECTOR_STORE_TYPE=memory  # Use 'qdrant' for production
   AGENTX_API_KEY=your-api-key-here
   ```

4. **Start the server**:
   ```bash
   npm start
   ```

5. **Verify setup**:
   ```bash
   curl http://localhost:3080/api/health
   # Expected: {"status":"ok","mongodb":"connected","ollama":"available"}
   ```

### Development Tools

**Recommended IDE Setup:**
- VS Code Extensions: ESLint, MongoDB for VS Code, REST Client
- Database Tools: MongoDB Compass, Studio 3T (optional)

**Debugging:**
```bash
node --inspect src/app.js  # Debug mode with inspector
```

**Hot Reload:**
```bash
npm install -g nodemon  # Install nodemon globally
nodemon src/app.js      # Start with auto-reload
```

### Git Pre-Commit Hook

Set up automatic testing before commits:

```bash
# Create .git/hooks/pre-commit
#!/bin/sh
echo "Running tests before commit..."
npm test

if [ $? -ne 0 ]; then
  echo "Tests failed. Commit aborted."
  exit 1
fi
```

Make it executable:
```bash
chmod +x .git/hooks/pre-commit
```

**Alternative:** Use the automated setup script (if available):
```bash
./scripts/setup-git-hooks.sh
```
