# 🎯 SPRINT 1 - MVP ULTRA-SIMPLE
## Fonctionnel sans flafla

**Durée:** 3-4 jours
**Philosophie:** Make it work, not perfect

---

## 📋 TODO Liste Simple

### Jour 1-2: Prompt Framework (Minimum Viable)

**File 1:** `/home/yb/codes/AgentX/models/AgentPrompt.js`
```javascript
const mongoose = require('mongoose');

const agentPromptSchema = new mongoose.Schema({
  name: { type: String, required: true, unique: true },
  template: { type: String, required: true },
  variables: [String],  // Simple array: ['user', 'task', 'context']
  tags: [String]
}, { timestamps: true });

module.exports = mongoose.model('AgentPrompt', agentPromptSchema);
```

**File 2:** `/home/yb/codes/AgentX/routes/prompts.js`
```javascript
const express = require('express');
const router = express.Router();
const AgentPrompt = require('../models/AgentPrompt');

// List all
router.get('/', async (req, res) => {
  const prompts = await AgentPrompt.find();
  res.json(prompts);
});

// Get one
router.get('/:name', async (req, res) => {
  const prompt = await AgentPrompt.findOne({ name: req.params.name });
  res.json(prompt || { error: 'Not found' });
});

// Create
router.post('/', async (req, res) => {
  try {
    const prompt = await AgentPrompt.create(req.body);
    res.json(prompt);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Render (simple string replace)
router.post('/:name/render', async (req, res) => {
  const prompt = await AgentPrompt.findOne({ name: req.params.name });
  if (!prompt) return res.status(404).json({ error: 'Not found' });

  let rendered = prompt.template;
  for (const [key, val] of Object.entries(req.body)) {
    rendered = rendered.replace(new RegExp(`{{${key}}}`, 'g'), val);
  }

  res.json({ rendered });
});

module.exports = router;
```

**File 3:** Ajouter route dans `/home/yb/codes/AgentX/src/app.js`
```javascript
// Add after existing routes
app.use('/api/prompts', require('../routes/prompts'));
```

**Test:**
```bash
# Create prompt
curl -X POST http://localhost:3080/api/prompts \
  -H "Content-Type: application/json" \
  -d '{
    "name": "test",
    "template": "Hello {{name}}, do {{task}}",
    "variables": ["name", "task"]
  }'

# Render
curl -X POST http://localhost:3080/api/prompts/test/render \
  -H "Content-Type: application/json" \
  -d '{"name": "yb", "task": "test this"}'
```

✅ **Done. 30 lignes de code. Ça marche.**

---

### Jour 2-3: Benchmark Service (Minimum Viable)

**Setup:**
```bash
mkdir -p /home/yb/codes/BenchmarkService
cd /home/yb/codes/BenchmarkService
npm init -y
npm install express node-fetch dotenv
```

**File 1:** `/home/yb/codes/BenchmarkService/server.js`
```javascript
const express = require('express');
const fetch = require('node-fetch');
require('dotenv').config();

const app = express();
app.use(express.json());

// Simple in-memory storage
const results = [];

// Run single test
app.post('/test', async (req, res) => {
  const { model, host, prompt } = req.body;

  const start = Date.now();

  try {
    const response = await fetch(`${host}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, prompt, stream: false }),
      timeout: 30000
    });

    const data = await response.json();
    const latency = Date.now() - start;

    const result = {
      id: Date.now(),
      model,
      host,
      prompt,
      latency,
      response: data.response,
      timestamp: new Date()
    };

    results.push(result);
    res.json(result);

  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get all results
app.get('/results', (req, res) => {
  res.json(results);
});

// Health
app.get('/health', (req, res) => {
  res.json({ ok: true, results_count: results.length });
});

const PORT = process.env.PORT || 3081;
app.listen(PORT, () => {
  console.log(`Benchmark service running on port ${PORT}`);
});
```

**File 2:** `/home/yb/codes/BenchmarkService/.env`
```bash
PORT=3081
```

**Test:**
```bash
# Start service
node server.js

# Run test
curl -X POST http://localhost:3081/test \
  -H "Content-Type: application/json" \
  -d '{
    "model": "qwen2.5:7b",
    "host": "http://192.168.2.99:11434",
    "prompt": "Say hello"
  }'

# Get results
curl http://localhost:3081/results
```

✅ **Done. 50 lignes de code. Ça marche.**

---

### Jour 3-4: Janitor (Minimum Viable)

**File 1:** `/home/yb/codes/DataAPI/routes/janitor.routes.js`
```javascript
const express = require('express');
const router = express.Router();
const fs = require('fs').promises;
const path = require('path');
const crypto = require('crypto');

// Analyze directory
router.post('/analyze', async (req, res) => {
  const { path: scanPath } = req.body;

  if (!scanPath) {
    return res.status(400).json({ error: 'path required' });
  }

  try {
    const result = await analyzeDirectory(scanPath);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Simple recursive analyzer
async function analyzeDirectory(dirPath) {
  const fileMap = new Map(); // hash -> files
  let totalFiles = 0;
  let totalSize = 0;

  async function scan(dir) {
    const entries = await fs.readdir(dir, { withFileTypes: true });

    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);

      if (entry.isDirectory()) {
        await scan(fullPath);
      } else if (entry.isFile()) {
        const stats = await fs.stat(fullPath);
        totalFiles++;
        totalSize += stats.size;

        // Skip large files
        if (stats.size > 100 * 1024 * 1024) continue;

        // Hash file
        const content = await fs.readFile(fullPath);
        const hash = crypto.createHash('sha256').update(content).digest('hex');

        if (!fileMap.has(hash)) fileMap.set(hash, []);
        fileMap.get(hash).push({ path: fullPath, size: stats.size });
      }
    }
  }

  await scan(dirPath);

  // Find duplicates
  const duplicates = [];
  for (const [hash, files] of fileMap.entries()) {
    if (files.length > 1) {
      duplicates.push({
        hash,
        files,
        wasted: files[0].size * (files.length - 1)
      });
    }
  }

  const totalWasted = duplicates.reduce((sum, d) => sum + d.wasted, 0);

  return {
    path: dirPath,
    total_files: totalFiles,
    total_size: totalSize,
    duplicates: duplicates.length,
    wasted_space: totalWasted,
    duplicate_details: duplicates
  };
}

module.exports = router;
```

**File 2:** Ajouter dans `/home/yb/codes/DataAPI/data_serv.js`
```javascript
// Add after existing routes
const janitorRoutes = require('./routes/janitor.routes');
app.use('/api/v1/janitor', janitorRoutes);
```

**Test:**
```bash
curl -X POST http://localhost:3003/api/v1/janitor/analyze \
  -H "Content-Type: application/json" \
  -H "x-api-key: $DATAAPI_API_KEY" \
  -d '{"path": "/path/to/test/folder"}'
```

✅ **Done. 60 lignes de code. Ça marche.**

---

## 🚀 PM2 Update (Simple)

**File:** `/home/yb/codes/ecosystem.config.js`
```javascript
module.exports = {
  apps: [
    {
      name: 'DataAPI',
      script: './DataAPI/data_serv.js',
      env: { PORT: 3003 }
    },
    {
      name: 'AgentX',
      script: './AgentX/server.js',
      env: { PORT: 3080 }
    },
    {
      name: 'Benchmark',
      script: './BenchmarkService/server.js',
      env: { PORT: 3081 }
    }
  ]
};
```

**Deploy:**
```bash
pm2 delete all
pm2 start ecosystem.config.js
pm2 save
```

---

## ✅ Success Checklist (Simple)

- [ ] Prompt: Create, read, render work
- [ ] Benchmark: Can test 1 model, see results
- [ ] Janitor: Can scan folder, find duplicates
- [ ] All 3 services running via PM2
- [ ] No errors in logs

**Total Code:** ~140 lignes
**Total Time:** 3-4 jours
**Complexity:** Minimal

---

## 📝 Quick Test Script

**File:** `/home/yb/codes/test-mvp.sh`
```bash
#!/bin/bash

echo "=== Testing MVP ==="

# 1. Test Prompt
echo "\n1. Prompt Framework:"
curl -s -X POST http://localhost:3080/api/prompts \
  -H "Content-Type: application/json" \
  -d '{"name":"hello","template":"Hi {{name}}!","variables":["name"]}' | jq

curl -s -X POST http://localhost:3080/api/prompts/hello/render \
  -H "Content-Type: application/json" \
  -d '{"name":"world"}' | jq

# 2. Test Benchmark
echo "\n2. Benchmark Service:"
curl -s -X POST http://localhost:3081/test \
  -H "Content-Type: application/json" \
  -d '{
    "model":"qwen2.5:7b",
    "host":"http://192.168.2.99:11434",
    "prompt":"What is 2+2?"
  }' | jq

# 3. Test Janitor
echo "\n3. Janitor:"
curl -s -X POST http://localhost:3003/api/v1/janitor/analyze \
  -H "Content-Type: application/json" \
  -H "x-api-key: $DATAAPI_API_KEY" \
  -d '{"path":"/tmp/test"}' | jq

echo "\n=== All tests complete ==="
```

```bash
chmod +x test-mvp.sh
./test-mvp.sh
```

---

## 🎯 Next Steps (After MVP Works)

**Sprint 2** (si tu veux):
- Prompt: Template engine (if/loops)
- Benchmark: Multiple models, charts
- Janitor: Policies, auto-cleanup

**Mais pour l'instant:**
- Make it work ✅
- Make it right (later)
- Make it fast (even later)

---

**Ready to code?**
```bash
cd /home/yb/codes
git checkout -b mvp-simple
echo "Let's build! 🚀"
```
