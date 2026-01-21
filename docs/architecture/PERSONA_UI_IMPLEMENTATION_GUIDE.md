# Persona UI System - Implementation Guide

## Quick Start

This guide shows you how to implement specialized UIs for AgentX personas like repoWatcher and visual LLM.

## Files Created

1. **Architecture Doc**: `/docs/architecture/PERSONA_UI_ARCHITECTURE.md`
2. **Persona Configs**:
   - `/personas/repo_watcher.json` - Dashboard persona
   - `/personas/visual_llm.json` - Gallery persona
3. **UI Prototypes**:
   - `/public/imageGen.html` - Image gallery interface

## Implementation Steps

### Step 1: Extend PromptConfig Schema

Add the `uiConfig` field to `/models/PromptConfig.js`:

```javascript
const PromptConfigSchema = new mongoose.Schema({
  // ... existing fields ...

  uiConfig: {
    type: {
      type: String,
      enum: ['chat', 'dashboard', 'gallery', 'hybrid'],
      default: 'chat'
    },
    route: {
      type: String,
      default: '/index.html'
    },
    capabilities: [{
      type: String,
      enum: ['text', 'images', 'charts', 'files', 'realtime', 'code']
    }],
    layoutConfig: {
      type: mongoose.Schema.Types.Mixed,
      default: {}
    }
  }
});
```

### Step 2: Create Migration Script

Create `/scripts/migrate-persona-ui.js`:

```javascript
const mongoose = require('mongoose');
const PromptConfig = require('../models/PromptConfig');

async function migrate() {
  await mongoose.connect(process.env.MONGODB_URI);

  // Update existing personas with default uiConfig
  await PromptConfig.updateMany(
    { uiConfig: { $exists: false } },
    {
      $set: {
        uiConfig: {
          type: 'chat',
          route: '/index.html',
          capabilities: ['text'],
          layoutConfig: {}
        }
      }
    }
  );

  console.log('Migration complete');
  process.exit(0);
}

migrate().catch(console.error);
```

### Step 3: Seed New Personas

```bash
# Seed repoWatcher persona
node scripts/seed-persona.js personas/repo_watcher.json

# Seed visual LLM persona
node scripts/seed-persona.js personas/visual_llm.json
```

### Step 4: Create API Endpoints

Add to `/routes/api.js`:

```javascript
// Get persona metadata (including UI config)
router.get('/personas/:name', async (req, res) => {
  try {
    const persona = await PromptConfig.findOne({
      name: req.params.name,
      isActive: true
    });

    if (!persona) {
      return res.status(404).json({ error: 'Persona not found' });
    }

    res.json({
      name: persona.name,
      description: persona.description,
      uiConfig: persona.uiConfig,
      stats: persona.stats
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});
```

### Step 5: Build Specialized UIs

#### For repoWatcher Dashboard

Create `/public/repoWatcher.html` (see architecture doc for full layout).

Key endpoints needed:
```javascript
GET  /api/repoWatcher/status    // Current scan status
GET  /api/repoWatcher/findings  // Latest findings
POST /api/repoWatcher/scan      // Trigger manual scan
GET  /api/repoWatcher/history   // Historical scans
```

#### For Visual LLM Gallery

Already created at `/public/imageGen.html`.

Key modifications needed to `/src/services/chatService.js`:

```javascript
// In chatService.processMessage()
if (persona.name === 'visual_llm') {
  // Generate image using local LLM
  const imageUrl = await generateImage(userMessage);

  // Save to conversation with attachment
  conversation.messages.push({
    role: 'assistant',
    content: 'Generated image based on your prompt',
    attachments: [{
      type: 'image',
      url: imageUrl,
      metadata: {
        model: selectedModel,
        prompt: userMessage,
        timestamp: new Date()
      }
    }]
  });
}
```

### Step 6: Extend Conversation Schema

Add support for attachments in `/models/Conversation.js`:

```javascript
const MessageSchema = new mongoose.Schema({
  role: { type: String, enum: ['user', 'assistant', 'system'] },
  content: String,
  timestamp: { type: Date, default: Date.now },

  // NEW: Attachment support
  attachments: [{
    type: {
      type: String,
      enum: ['image', 'file', 'chart']
    },
    url: String,
    metadata: mongoose.Schema.Types.Mixed
  }]
});
```

### Step 7: Add Frontend Router

Update `/public/index.html` to check persona UI type:

```javascript
// On page load, check if current persona needs different UI
async function checkPersonaUI() {
  const urlParams = new URLSearchParams(window.location.search);
  const personaName = urlParams.get('persona') || 'default_chat';

  const response = await fetch(`/api/personas/${personaName}`);
  const persona = await response.json();

  // Redirect to specialized UI if needed
  if (persona.uiConfig && persona.uiConfig.route !== '/index.html') {
    window.location.href = persona.uiConfig.route + '?persona=' + personaName;
  }
}

checkPersonaUI();
```

## Testing the System

### Test repoWatcher

1. Seed the persona:
   ```bash
   node scripts/seed-persona.js personas/repo_watcher.json
   ```

2. Navigate to: `http://localhost:3080/repoWatcher.html`

3. Expected behavior:
   - Dashboard shows "No scans yet"
   - Manual scan button triggers first scan
   - Findings appear with severity indicators

### Test Visual LLM

1. Seed the persona:
   ```bash
   node scripts/seed-persona.js personas/visual_llm.json
   ```

2. Navigate to: `http://localhost:3080/imageGen.html`

3. Test image generation:
   ```
   Prompt: "A serene mountain landscape at sunset"
   Model: llama-vision-v1
   Click: Generate
   ```

4. Expected behavior:
   - Loading spinner appears
   - Image is generated and added to gallery
   - Can click image for lightbox view
   - Can download or regenerate

## Integration with Existing Features

### Workspace Support

Personas with custom UIs should respect workspace context:

```javascript
// In specialized UI pages
const workspaceId = localStorage.getItem('currentWorkspace');

fetch('/api/repoWatcher/status', {
  headers: {
    'Authorization': `Bearer ${token}`,
    'X-Workspace-ID': workspaceId
  }
});
```

### Analytics Tracking

Track usage of specialized personas:

```javascript
// Track persona view
await fetch('/api/analytics/track', {
  method: 'POST',
  body: JSON.stringify({
    event: 'persona_view',
    persona: 'visual_llm',
    uiType: 'gallery'
  })
});
```

## Next Steps

1. **Build repoWatcher backend service** (`/src/services/repoWatcherService.js`)
2. **Integrate image generation** in chatService for visual_llm
3. **Create persona UI builder tool** for rapid prototyping
4. **Add WebSocket support** for real-time dashboard updates
5. **Build mobile-responsive versions** of specialized UIs
6. **Add RBAC checks** for persona access control

## Common Patterns

### Pattern 1: Persona Selector in Dashboard

Add to `/public/dashboard.html`:

```html
<div class="persona-grid">
  <a href="/index.html?persona=default_chat" class="persona-card">
    <i class="fas fa-comments"></i>
    <h3>Chat</h3>
    <p>General conversation</p>
  </a>

  <a href="/repoWatcher.html" class="persona-card">
    <i class="fas fa-shield-alt"></i>
    <h3>Repo Watcher</h3>
    <p>Code quality monitoring</p>
  </a>

  <a href="/imageGen.html" class="persona-card">
    <i class="fas fa-image"></i>
    <h3>Visual LLM</h3>
    <p>Image generation</p>
  </a>
</div>
```

### Pattern 2: Unified Navigation

All specialized UIs should include breadcrumb navigation:

```html
<nav class="breadcrumb">
  <a href="/dashboard.html">Dashboard</a>
  <i class="fas fa-chevron-right"></i>
  <a href="/imageGen.html">Visual LLM</a>
</nav>
```

## Troubleshooting

**Issue**: Persona UI not loading
- Check that persona exists in PromptConfig
- Verify `uiConfig.route` is correct
- Check browser console for errors

**Issue**: Images not displaying in gallery
- Verify `/public/generated/` directory exists and is writable
- Check attachment URLs in conversation documents
- Confirm image generation service is running

**Issue**: Dashboard showing stale data
- Implement WebSocket updates or polling
- Add manual refresh button
- Check API endpoint caching headers

## Resources

- Full architecture: `/docs/architecture/PERSONA_UI_ARCHITECTURE.md`
- Example personas: `/personas/*.json`
- UI prototypes: `/public/imageGen.html`, `/public/repoWatcher.html`
- Testing guide: `/docs/patterns/TESTING_PATTERNS.md`
