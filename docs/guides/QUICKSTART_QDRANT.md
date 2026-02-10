# Qdrant Vector Database - Quick Start Guide

**Status:** ✅ **PRODUCTION READY**
**Last Updated:** 2026-01-05

---

## 🚀 Quick Commands

### Check Qdrant Status
```bash
# PM2 status
pm2 status qdrant

# Health check
curl http://localhost:6333/healthz
# Should return: "healthz check passed"

# Collection info
curl http://localhost:6333/collections/agentx_embeddings
```

### Start/Stop/Restart
```bash
# Start Qdrant
pm2 start ecosystem.config.js --only qdrant
pm2 save

# Restart Qdrant
pm2 restart qdrant

# Stop Qdrant
pm2 stop qdrant

# View logs
pm2 logs qdrant --lines 50
```

### Backup & Restore
```bash
# Create snapshot via API
curl -X POST http://localhost:3080/api/backup/qdrant

# Manual backup via script
/home/yb/codes/AgentX/scripts/backup-qdrant.sh /mnt/datalake/backups/qdrant

# Restore from snapshot
/home/yb/codes/AgentX/scripts/restore-qdrant.sh /mnt/datalake/backups/qdrant/snapshot_file.snapshot

# List backups
ls -lh /mnt/datalake/backups/qdrant/
```

---

## 📊 Monitoring

### Health Dashboard
- **URL:** http://192.168.2.33:3080/n8n-monitor.html
- **Feature:** Shows "Qdrant Vector DB" health card with real-time status
- **Auto-refresh:** Checks health on page refresh

### System Health API
```bash
# Dedicated Qdrant health check endpoint (recommended)
curl -s http://localhost:3080/api/health/qdrant | jq

# Expected output when healthy:
{
  "status": "connected",
  "message": "Vector database operational",
  "url": "http://localhost:6333",
  "vectorStoreType": "qdrant",
  "healthy": true,
  "lastCheck": "2026-01-05T07:30:31.365Z"
}

# Full system health check (includes Qdrant)
curl -s http://localhost:3080/health/detailed | jq '.services.qdrant'
```

### PM2 Monitoring
```bash
# Real-time metrics
pm2 monit

# Process info
pm2 info qdrant

# Memory usage
pm2 list | grep qdrant
```

---

## 🔧 Configuration

### Environment Variables (.env)
```bash
VECTOR_STORE_TYPE=qdrant
QDRANT_URL=http://localhost:6333
QDRANT_COLLECTION=agentx_embeddings
EMBEDDING_MODEL=nomic-embed-text
```

### PM2 Configuration (ecosystem.config.js)
```javascript
{
  name: 'qdrant',
  cwd: '/home/yb/codes/AgentX',
  script: './qdrant',
  exec_interpreter: 'none',
  args: '--config-path qdrant_config.yaml',
  instances: 1,
  exec_mode: 'fork',
  autorestart: true,
  max_restarts: 10,
  min_uptime: '5s'
}
```

---

## 🗂️ File Locations

| Item                  | Path                                                          |
|-----------------------|---------------------------------------------------------------|
| Qdrant Binary         | `/home/yb/codes/AgentX/qdrant`                                |
| Config File           | `/home/yb/codes/AgentX/qdrant_config.yaml`                    |
| Data Storage          | `/home/yb/codes/AgentX/qdrant_storage/`                       |
| Backup Directory      | `/mnt/datalake/backups/qdrant/`                               |
| Backup Script         | `/home/yb/codes/AgentX/scripts/backup-qdrant.sh`              |
| Restore Script        | `/home/yb/codes/AgentX/scripts/restore-qdrant.sh`             |

---

## 🧪 Testing RAG with Qdrant

### Test Vector Search
```bash
# Ingest a test document (via AgentX API)
curl -X POST http://localhost:3080/api/rag/ingest \
  -H "Content-Type: application/json" \
  -d '{
    "text": "Qdrant is a vector database optimized for similarity search.",
    "title": "Qdrant Test Document",
    "metadata": {"source": "test"}
  }'

# Search for similar documents
curl -X POST http://localhost:3080/api/rag/search \
  -H "Content-Type: application/json" \
  -d '{
    "query": "What is Qdrant?",
    "topK": 3
  }'
```

### Chat with RAG Enabled
1. Open http://192.168.2.33:3080
2. Enable "RAG" toggle in configuration panel
3. Ask: "Tell me about vector databases"
4. Assistant should retrieve context from Qdrant

---

## 🚨 Troubleshooting

### Qdrant Won't Start
```bash
# Check if port 6333 is already in use
netstat -tuln | grep 6333

# Check logs for errors
pm2 logs qdrant --err --lines 50

# Try manual start to see errors
cd /home/yb/codes/AgentX
./qdrant --config-path qdrant_config.yaml
```

### Health Check Fails
```bash
# Verify Qdrant is listening
curl -v http://localhost:6333/healthz

# Check PM2 status
pm2 status qdrant

# Restart if needed
pm2 restart qdrant && sleep 2 && curl http://localhost:6333/healthz
```

### Backup Fails
```bash
# Check backup directory permissions
ls -la /mnt/datalake/backups/qdrant/

# Create directory if missing
mkdir -p /mnt/datalake/backups/qdrant

# Run backup script manually
/home/yb/codes/AgentX/scripts/backup-qdrant.sh /mnt/datalake/backups/qdrant
```

### Out of Memory
```bash
# Check memory usage
pm2 list | grep qdrant

# If > 500MB, restart
pm2 restart qdrant

# Limit memory (optional)
pm2 restart qdrant --max-memory-restart 300M
```

---

## 📈 Performance Tips

### Optimize for Production
1. **Increase RAM allocation** if dealing with large datasets (> 100K vectors)
2. **Enable compression** in qdrant_config.yaml for storage efficiency
3. **Monitor query latency** - should be < 50ms for most queries
4. **Regular backups** - Schedule daily snapshots via cron

### Query Optimization
```javascript
// Use appropriate topK values
const results = await ragStore.search(query, {
  topK: 5,           // Don't over-fetch
  scoreThreshold: 0.7 // Filter low-quality matches
});
```

---

## 🎯 Next Steps

- [ ] **Set up automated backups** - Use backup dashboard to schedule cron jobs
- [ ] **Monitor performance** - Track query latency and memory usage
- [ ] **Ingest production data** - Migrate documents from in-memory to Qdrant
- [ ] **Test disaster recovery** - Verify restore process works correctly
- [ ] **Optimize collection settings** - Tune for your specific use case

---

## 📚 Additional Resources

- **Full Deployment Guide:** [docs/operations/QDRANT_DEPLOYMENT.md](../operations/QDRANT_DEPLOYMENT.md)
- **RAG Architecture:** [docs/architecture/V3_RAG_ARCHITECTURE.md](../architecture/V3_RAG_ARCHITECTURE.md)
- **Qdrant Official Docs:** https://qdrant.tech/documentation/
- **Fix Log:** FIXES_2026-01-05.md

---

**For support, check logs:** `pm2 logs qdrant` or `/home/yb/codes/AgentX/logs/qdrant.*.log`
