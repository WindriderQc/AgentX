# AgentX Deployment Guide

**Version:** 1.0.0  
**Last Updated:** December 4, 2025

This guide covers multiple deployment strategies for AgentX in production environments.

---

## Table of Contents

1. [Prerequisites](#prerequisites)
2. [Configuration](#configuration)
3. [Deployment Options](#deployment-options)
   - [Option 1: Docker (Recommended)](#option-1-docker-recommended)
   - [Option 2: systemd Service](#option-2-systemd-service)
   - [Option 3: PM2 Process Manager](#option-3-pm2-process-manager)
4. [Post-Deployment Validation](#post-deployment-validation)
5. [Troubleshooting](#troubleshooting)
6. [Maintenance](#maintenance)

---

## Prerequisites

### Required Services

1. **Node.js 18+**
   ```bash
   node --version  # Should be v18.0.0 or higher
   ```
   
   **Note:** Node.js v21.7.3 (TrueNasBot) is supported but may show warnings for Jest v30 packages during `npm install`. These are dev dependencies and don't affect production runtime.

2. **MongoDB**
   - Local: MongoDB 5.0+ running on `localhost:27017`
   - Remote: Connection string with authentication
   - Cloud: MongoDB Atlas free tier supported

3. **Ollama**
   - Install from: https://ollama.ai
   - Minimum one chat model (e.g., `llama3`, `mistral`)
   - Embedding model: `nomic-embed-text`
   
   ```bash
   # Pull required models
   ollama pull llama3
   ollama pull nomic-embed-text
   
   # Verify
   ollama list
   ```

### System Requirements

- **RAM:** 4GB minimum (8GB+ recommended for larger models)
- **Disk:** 10GB+ for models and database
- **CPU:** Multi-core recommended for concurrent requests
- **Network:** Internet access for initial model downloads

---

## Configuration

### 1. Create Environment File

Copy the example and customize:

```bash
cp .env.example .env
```

### 2. Edit `.env`

```bash
# Database Configuration
DB_TYPE=mongodb
MONGO_URI=mongodb://localhost:27017/agentx

# Server Configuration
PORT=3080

# Ollama Configuration
OLLAMA_HOST=http://localhost:11434
EMBEDDING_MODEL=nomic-embed-text
```

### Configuration Options

| Variable | Default | Description |
|----------|---------|-------------|
| `DB_TYPE` | `mongodb` | Database type (only mongodb supported in v1.0) |
| `MONGO_URI` | `mongodb://localhost:27017/agentx` | MongoDB connection string |
| `PORT` | `3080` | HTTP server port |
| `OLLAMA_HOST` | `http://localhost:11434` | Ollama API endpoint |
| `EMBEDDING_MODEL` | `nomic-embed-text` | Model for RAG embeddings |

### MongoDB Atlas Configuration

For cloud MongoDB:

```bash
MONGO_URI=mongodb+srv://username:password@cluster.mongodb.net/agentx?retryWrites=true&w=majority
```

### Remote Ollama Configuration

If Ollama runs on another machine:

```bash
OLLAMA_HOST=http://192.168.1.100:11434
```

**Note:** Ensure Ollama is configured to accept remote connections:
```bash
# On the Ollama host
export OLLAMA_HOST=0.0.0.0
ollama serve
```

---

## Deployment Options

## Option 1: Docker (Recommended)

### Benefits
- Isolated environment
- Easy scaling and updates
- Consistent across platforms
- Includes all dependencies

### Step 1: Create Dockerfile

```dockerfile
# File: Dockerfile
FROM node:18-alpine

WORKDIR /app

# Copy package files
COPY package*.json ./

# Install dependencies
RUN npm ci --only=production

# Copy application code
COPY . .

# Expose port
EXPOSE 3080

# Health check
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD node -e "require('http').get('http://localhost:3080/health', (r) => {process.exit(r.statusCode === 200 ? 0 : 1)})"

# Start application
CMD ["node", "server.js"]
```

### Step 2: Create docker-compose.yml

```yaml
# File: docker-compose.yml
version: '3.8'

services:
  agentx:
    build: .
    container_name: agentx
    ports:
      - "3080:3080"
    environment:
      - NODE_ENV=production
      - MONGO_URI=mongodb://mongo:27017/agentx
      - OLLAMA_HOST=http://host.docker.internal:11434
      - PORT=3080
      - EMBEDDING_MODEL=nomic-embed-text
    depends_on:
      - mongo
    restart: unless-stopped
    networks:
      - agentx-network

  mongo:
    image: mongo:7
    container_name: agentx-mongo
    ports:
      - "27017:27017"
    volumes:
      - mongo-data:/data/db
    restart: unless-stopped
    networks:
      - agentx-network

volumes:
  mongo-data:

networks:
  agentx-network:
    driver: bridge
```

### Step 3: Deploy

```bash
# Build and start
docker-compose up -d

# View logs
docker-compose logs -f agentx

# Stop
docker-compose down

# Update application
git pull
docker-compose up -d --build
```

### Docker Notes

- **Ollama Access:** Uses `host.docker.internal` to access Ollama on host machine
- **Alternative:** Run Ollama in Docker (requires GPU passthrough)
- **Data Persistence:** MongoDB data stored in named volume
- **Networking:** Services communicate via internal network

---

## Option 2: systemd Service

### Benefits
- Native Linux integration
- Auto-restart on failure
- System boot integration
- Centralized logging

### Step 1: Create Service File

```bash
sudo nano /etc/systemd/system/agentx.service
```

```ini
[Unit]
Description=AgentX AI Assistant
After=network.target mongod.service
Wants=mongod.service

[Service]
Type=simple
User=agentx
WorkingDirectory=/opt/agentx
Environment="NODE_ENV=production"
EnvironmentFile=/opt/agentx/.env
ExecStart=/usr/bin/node /opt/agentx/server.js
Restart=on-failure
RestartSec=10
StandardOutput=journal
StandardError=journal
SyslogIdentifier=agentx

# Security hardening
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=/opt/agentx

[Install]
WantedBy=multi-user.target
```

### Step 2: Setup Application

```bash
# Create service user
sudo useradd -r -s /bin/false agentx

# Create application directory
sudo mkdir -p /opt/agentx
sudo chown agentx:agentx /opt/agentx

# Copy application
sudo cp -r /path/to/AgentX/* /opt/agentx/
sudo chown -R agentx:agentx /opt/agentx

# Install dependencies as agentx user
sudo -u agentx bash -c "cd /opt/agentx && npm ci --only=production"

# Create .env file
sudo -u agentx nano /opt/agentx/.env
```

### Step 3: Enable and Start

```bash
# Reload systemd
sudo systemctl daemon-reload

# Enable auto-start on boot
sudo systemctl enable agentx

# Start service
sudo systemctl start agentx

# Check status
sudo systemctl status agentx

# View logs
sudo journalctl -u agentx -f
```

### systemd Commands

```bash
# Start service
sudo systemctl start agentx

# Stop service
sudo systemctl stop agentx

# Restart service
sudo systemctl restart agentx

# View status
sudo systemctl status agentx

# View logs (last 100 lines)
sudo journalctl -u agentx -n 100

# View logs (live tail)
sudo journalctl -u agentx -f

# Disable auto-start
sudo systemctl disable agentx
```

---

## Option 3: PM2 Process Manager

### Benefits
- Zero-downtime reloads
- Built-in clustering
- Process monitoring
- Log management
- Easy deployment workflows

### Step 1: Install PM2

```bash
npm install -g pm2
```

### Step 2: Create PM2 Configuration

```javascript
// File: ecosystem.config.js
module.exports = {
  apps: [{
    name: 'agentx',
    script: './server.js',
    instances: 1,
    exec_mode: 'fork',
    watch: false,
    env: {
      NODE_ENV: 'production',
      PORT: 3080
    },
    error_file: './logs/err.log',
    out_file: './logs/out.log',
    log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
    merge_logs: true,
    max_memory_restart: '500M',
    restart_delay: 4000,
    autorestart: true,
    max_restarts: 10,
    min_uptime: '10s'
  }]
};
```

### Step 3: Deploy

```bash
# Create logs directory
mkdir -p logs

# Start application
pm2 start ecosystem.config.js

# Save PM2 configuration
pm2 save

# Setup auto-start on system boot
pm2 startup
# Follow the instructions printed by the command
```

### PM2 Commands

```bash
# Start
pm2 start ecosystem.config.js

# Stop
pm2 stop agentx

# Restart
pm2 restart agentx

# Reload (zero-downtime)
pm2 reload agentx

# Delete from PM2
pm2 delete agentx

# View status
pm2 status

# View logs
pm2 logs agentx

# Monitor resources
pm2 monit

# View detailed info
pm2 show agentx
```

### PM2 Clustering

For multi-core machines:

```javascript
// ecosystem.config.js
instances: 'max',  // Use all CPU cores
exec_mode: 'cluster'
```

---

## Post-Deployment Validation

### 1. Health Check

```bash
curl http://localhost:3080/health
# Expected: {"status":"ok","port":3080}

curl http://localhost:3080/health/detailed
# Should show MongoDB and Ollama status
```

### 2. Test Chat Endpoint

```bash
curl -X POST http://localhost:3080/api/chat \
  -H "Content-Type: application/json" \
  -d '{
    "model": "llama3",
    "message": "Hello, test message",
    "userId": "test"
  }'
```

### 3. Test RAG Ingestion

```bash
curl -X POST http://localhost:3080/api/rag/ingest \
  -H "Content-Type: application/json" \
  -d '{
    "documents": [
      {
        "id": "test-doc-1",
        "text": "This is a test document for RAG validation.",
        "metadata": {"source": "deployment-test"}
      }
    ]
  }'
```

### 4. Verify Frontend

Open browser and navigate to:
```
http://localhost:3080
```

Check:
- ✅ UI loads correctly
- ✅ Model selection works
- ✅ Can send messages
- ✅ History sidebar populates
- ✅ Configuration panel accessible

### 5. Monitor Logs

**Docker:**
```bash
docker-compose logs -f agentx
```

**systemd:**
```bash
sudo journalctl -u agentx -f
```

**PM2:**
```bash
pm2 logs agentx
```

---

## Troubleshooting

### Issue: Server won't start

**Symptoms:**
- Port already in use
- MongoDB connection fails
- Missing dependencies

**Solutions:**

```bash
# Check if port is in use
sudo lsof -i :3080
# Kill process if needed
sudo kill -9 <PID>

# Check MongoDB status
sudo systemctl status mongod
# Start if stopped
sudo systemctl start mongod

# Reinstall dependencies
rm -rf node_modules package-lock.json
npm install
```

### Issue: MongoDB connection timeout

**Symptoms:**
```
Error: connect ECONNREFUSED 127.0.0.1:27017
```

**Solutions:**

```bash
# Start MongoDB
sudo systemctl start mongod

# Check MongoDB is running
sudo systemctl status mongod

# Test connection
mongosh --eval "db.adminCommand('ping')"

# Check connection string in .env
cat .env | grep MONGO_URI
```

### Issue: Ollama not responding

**Symptoms:**
```
Error: connect ECONNREFUSED localhost:11434
```

**Solutions:**

```bash
# Check Ollama service
systemctl status ollama  # or ps aux | grep ollama

# Start Ollama
ollama serve &

# Test Ollama API
curl http://localhost:11434/api/tags

# Check models are available
ollama list
```

### Issue: RAG embeddings fail

**Symptoms:**
- RAG toggle doesn't work
- Embedding generation errors

**Solutions:**

```bash
# Ensure embedding model is pulled
ollama pull nomic-embed-text

# Verify in .env
cat .env | grep EMBEDDING_MODEL

# Test embedding endpoint
curl http://localhost:11434/api/embeddings \
  -d '{"model":"nomic-embed-text","prompt":"test"}'
```

### Issue: Permission denied errors

**systemd specific:**

```bash
# Fix ownership
sudo chown -R agentx:agentx /opt/agentx

# Fix permissions
sudo chmod -R 755 /opt/agentx
sudo chmod 600 /opt/agentx/.env
```

### Issue: High memory usage

**Solutions:**

```bash
# Check current memory
free -h

# PM2: Set memory limit
pm2 start ecosystem.config.js --max-memory-restart 500M

# Docker: Set memory limit in docker-compose.yml
services:
  agentx:
    mem_limit: 1g
```

### Debugging Tips

1. **Enable detailed logging:**
   ```bash
   NODE_ENV=development node server.js
   ```

2. **Check environment variables:**
   ```bash
   env | grep -E 'MONGO|OLLAMA|PORT'
   ```

3. **Test database connection:**
   ```javascript
   // test-db.js
   const mongoose = require('mongoose');
   mongoose.connect(process.env.MONGO_URI)
     .then(() => console.log('✓ MongoDB connected'))
     .catch(err => console.error('✗ Error:', err));
   ```

4. **Monitor system resources:**
   ```bash
   htop  # or top
   df -h  # disk space
   ```

---

## Maintenance

### Backup Database

```bash
# Backup MongoDB
mongodump --uri="mongodb://localhost:27017/agentx" --out=/backup/agentx-$(date +%Y%m%d)

# Restore MongoDB
mongorestore --uri="mongodb://localhost:27017/agentx" /backup/agentx-20250204
```

### Update Application

**Git-based updates:**

```bash
# systemd
cd /opt/agentx
sudo -u agentx git pull
sudo -u agentx npm ci --only=production
sudo systemctl restart agentx

# PM2
git pull
npm ci --only=production
pm2 reload agentx

# Docker
git pull
docker-compose up -d --build
```

### Log Rotation

**PM2 (built-in):**
```bash
pm2 install pm2-logrotate
pm2 set pm2-logrotate:max_size 10M
pm2 set pm2-logrotate:retain 7
```

**systemd (automatic via journald):**
```bash
# Configure in /etc/systemd/journald.conf
SystemMaxUse=1G
SystemKeepFree=2G
```

### Monitoring

**Basic health monitoring script:**

```bash
#!/bin/bash
# File: monitor-agentx.sh

HEALTH_URL="http://localhost:3080/health"
WEBHOOK_URL="your-notification-webhook"

if ! curl -sf "$HEALTH_URL" > /dev/null; then
  echo "AgentX health check failed at $(date)"
  # Send alert (optional)
  curl -X POST "$WEBHOOK_URL" -d "AgentX is down!"
  exit 1
fi

echo "AgentX is healthy"
```

**Setup cron job:**
```bash
# Every 5 minutes
*/5 * * * * /opt/agentx/monitor-agentx.sh
```

### Performance Tuning

**Node.js memory:**
```bash
# In ecosystem.config.js or systemd service
node --max-old-space-size=512 server.js
```

**MongoDB indexes:**
```javascript
// Already created in models, verify with:
use agentx;
db.conversations.getIndexes();
db.promptconfigs.getIndexes();
```

### Security Hardening

1. **Firewall rules:**
   ```bash
   # Allow only localhost access
   sudo ufw allow from 127.0.0.1 to any port 3080
   
   # Or allow specific IP range
   sudo ufw allow from 192.168.1.0/24 to any port 3080
   ```

2. **Environment file permissions:**
   ```bash
   chmod 600 .env
   ```

3. **Regular updates:**
   ```bash
   npm audit
   npm audit fix
   ```

4. **MongoDB authentication:**
   ```bash
   # Enable auth in MongoDB config
   # Then use authenticated connection string
   MONGO_URI=mongodb://username:password@localhost:27017/agentx
   ```

---

## Production Checklist

Before going live:

- [ ] All environment variables configured
- [ ] MongoDB running and accessible
- [ ] Ollama models downloaded
- [ ] Health check endpoint returns 200
- [ ] Frontend accessible and functional
- [ ] RAG ingestion tested
- [ ] Logs properly configured
- [ ] Backup strategy in place
- [ ] Monitoring setup
- [ ] Firewall rules configured
- [ ] Auto-start configured (systemd/PM2)
- [ ] Documentation reviewed
- [ ] Test conversation works end-to-end

---

## Additional Resources

- **Architecture:** `docs/architecture/backend-overview.md`
- **API Reference:** `docs/api/reference.md`
- **Quick Start:** `docs/onboarding/quickstart.md`
- **n8n Integration:** `docs/reports/n8n-ingestion.md`
- **Troubleshooting:** GitHub Issues

---

## Support

For issues and questions:
- GitHub Issues: https://github.com/WindriderQc/AgentX/issues
- Documentation: `/docs` folder
- Health Check: http://localhost:3080/health/detailed

**End of Deployment Guide**
