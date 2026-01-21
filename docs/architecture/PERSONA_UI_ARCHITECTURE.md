# Persona UI Architecture

## Overview
AgentX personas require different UI patterns based on their output types. This document defines the extensible UI architecture for specialized persona interfaces.

## Architecture Principles

1. **Persona-Driven UI Selection**: Each persona declares its UI requirements via metadata
2. **Progressive Enhancement**: Start with chat, layer specialized UIs as needed
3. **Shared Components**: Reuse UI components across persona types
4. **Type Safety**: Enforce UI capabilities match persona output types

---

## Persona UI Types

### Type 1: Chat (Default)
**Route**: `/index.html`
**Use Case**: Text-based conversational agents
**Capabilities**: text
**Layout**: Message list + input field

**Examples**:
- `default_chat`
- `sbqc_workflow_architect`

**UI Components**:
- Message history (markdown rendering)
- Text input with autocomplete
- Feedback buttons (thumbs up/down)
- Model/persona selector

---

### Type 2: Dashboard
**Route**: `/[personaName].html` (custom)
**Use Case**: Monitoring, reporting, status display
**Capabilities**: text, charts, realtime
**Layout**: Status cards + data visualization

**Examples**:
- `repoWatcher` → `/repoWatcher.html`
- `systemMonitor` → `/systemHealth.html`

**UI Components**:
- Status indicator (ok/warn/fail)
- Severity-coded findings list
- Trend charts (Chart.js)
- Refresh/manual trigger buttons
- File path navigation (clickable)
- Timestamp + last scan info

**Data Flow**:
```
Persona (backend) → WebSocket/Polling → Dashboard UI
                 ↓
        Stores findings in MongoDB
                 ↓
        Dashboard fetches via REST API
```

---

### Type 3: Gallery (Image/Media)
**Route**: `/imageGen.html` or `/gallery.html`
**Use Case**: Visual LLM outputs, image generation
**Capabilities**: images, text
**Layout**: Image grid + prompt history

**Examples**:
- `visualLLM` → `/imageGen.html`
- `diagramGenerator` → `/gallery.html`

**UI Components**:
- Image grid with lazy loading
- Lightbox viewer
- Prompt input + history
- Download/export buttons
- Image metadata (model, seed, params)
- Regeneration controls

**Storage Pattern**:
```
Generated images → /public/generated/[userId]/[timestamp].png
Metadata → Conversation.messages[].attachments[]
```

---

### Type 4: Hybrid (Chat + Specialized Output)
**Route**: `/index.html` with dynamic right panel
**Use Case**: Conversational + rich output (code, charts, files)
**Capabilities**: text, images, charts, files
**Layout**: Chat (left 60%) + Output Panel (right 40%)

**Examples**:
- `codeAssistant` (chat + code preview)
- `dataAnalyst` (chat + charts)

**UI Components**:
- Standard chat interface (left)
- Dynamic output panel (right):
  - Code editor (Monaco/CodeMirror)
  - Chart viewer (Chart.js/D3)
  - File tree viewer
  - Image carousel

---

## PromptConfig Schema Extension

```javascript
// models/PromptConfig.js
const PromptConfigSchema = new mongoose.Schema({
  // ... existing fields ...

  // UI Configuration
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
      // Dashboard-specific
      refreshInterval: Number,      // ms, for auto-refresh
      statusColors: Object,          // custom color scheme

      // Gallery-specific
      imageDisplayMode: String,      // 'grid' | 'masonry' | 'carousel'
      imagesPerPage: Number,

      // Hybrid-specific
      splitRatio: String,            // '60/40' | '50/50' | '70/30'
      outputPanelType: String        // 'code' | 'chart' | 'mixed'
    },
    customCSS: String,               // Optional custom styling
    customJS: String                 // Optional custom behavior
  }
});
```

---

## Frontend Router Pattern

### Option A: Server-Side Route Detection
```javascript
// routes/chat.js
app.get('/chat/:personaName?', async (req, res) => {
  const personaName = req.params.personaName || 'default_chat';
  const persona = await PromptConfig.findOne({ name: personaName, isActive: true });

  if (!persona) {
    return res.redirect('/index.html');
  }

  // Redirect to specialized UI if configured
  if (persona.uiConfig && persona.uiConfig.route !== '/index.html') {
    return res.redirect(persona.uiConfig.route);
  }

  // Default to chat interface
  res.sendFile(path.join(__dirname, '../public/index.html'));
});
```

### Option B: Client-Side Dynamic Loading
```javascript
// public/js/personaRouter.js
async function loadPersonaUI(personaName) {
  const response = await fetch(`/api/personas/${personaName}`);
  const persona = await response.json();

  switch (persona.uiConfig.type) {
    case 'dashboard':
      window.location.href = persona.uiConfig.route;
      break;
    case 'gallery':
      initGalleryUI(persona);
      break;
    case 'hybrid':
      initHybridUI(persona);
      break;
    default:
      initChatUI(persona);
  }
}
```

---

## Specialized UI Pages

### repoWatcher Dashboard (`/public/repoWatcher.html`)

**Layout**:
```
┌─────────────────────────────────────────┐
│  Header: repoWatcher Status             │
│  [Manual Scan] [Settings] [History]     │
├─────────────────────────────────────────┤
│  Status: ● OK / ⚠ WARN / ✖ FAIL        │
│  Last Scan: 2025-01-21 14:32:15         │
│  Next Scan: in 3m 42s                   │
├─────────────────────────────────────────┤
│  Findings (3)                           │
│  ├─ ⚠ Missing test: src/foo/bar.js     │
│  ├─ ⚠ Doc duplication: README.md        │
│  └─ ⚠ Architecture: new folder /temp    │
├─────────────────────────────────────────┤
│  Trends (Chart)                         │
│  [Duplication] [Test Coverage] [Docs]   │
└─────────────────────────────────────────┘
```

**API Endpoints Needed**:
- `GET /api/repoWatcher/status` - Current status
- `GET /api/repoWatcher/findings` - Latest findings
- `POST /api/repoWatcher/scan` - Trigger manual scan
- `GET /api/repoWatcher/history` - Scan history

### imageGen Gallery (`/public/imageGen.html`)

**Layout**:
```
┌─────────────────────────────────────────┐
│  Header: Visual LLM Gallery             │
│  [New Image] [Filter] [Download All]    │
├─────────────────────────────────────────┤
│  Prompt Input                           │
│  ┌─────────────────────────────────┐   │
│  │ Describe the image you want...  │   │
│  └─────────────────────────────────┘   │
│  [Generate] Model: [llama-vision]      │
├─────────────────────────────────────────┤
│  Gallery (Grid)                         │
│  ┌───┐ ┌───┐ ┌───┐ ┌───┐             │
│  │ 1 │ │ 2 │ │ 3 │ │ 4 │             │
│  └───┘ └───┘ └───┘ └───┘             │
│  ┌───┐ ┌───┐ ┌───┐ ┌───┐             │
│  │ 5 │ │ 6 │ │ 7 │ │ 8 │             │
│  └───┘ └───┘ └───┘ └───┘             │
└─────────────────────────────────────────┘
```

**Data Model Extension**:
```javascript
// Conversation message with image attachment
{
  role: 'assistant',
  content: 'Generated image based on your prompt',
  attachments: [{
    type: 'image',
    url: '/generated/user123/20250121_143215.png',
    metadata: {
      model: 'llama-vision-v1',
      prompt: 'A serene mountain landscape...',
      seed: 42,
      dimensions: { width: 1024, height: 768 },
      generatedAt: '2025-01-21T14:32:15Z'
    }
  }]
}
```

---

## Implementation Roadmap

### Phase 1: Schema & API Foundation
- [ ] Extend PromptConfig with `uiConfig` field
- [ ] Create migration script for existing personas
- [ ] Add `GET /api/personas/:name` endpoint
- [ ] Add persona UI type validation

### Phase 2: repoWatcher Dashboard
- [ ] Create `/public/repoWatcher.html`
- [ ] Implement repoWatcher backend service
- [ ] Add repoWatcher API endpoints
- [ ] Seed `personas/repo_watcher.json` with uiConfig

### Phase 3: imageGen Gallery
- [ ] Create `/public/imageGen.html`
- [ ] Extend Conversation schema for attachments
- [ ] Add image upload/storage service
- [ ] Create gallery API endpoints

### Phase 4: Hybrid UI Components
- [ ] Create modular output panel components
- [ ] Add dynamic component loader to index.html
- [ ] Build reusable widgets (code viewer, chart panel)

### Phase 5: Developer Experience
- [ ] Document persona UI creation guide
- [ ] Create UI component library (`/public/js/components/`)
- [ ] Add persona UI preview tool
- [ ] Build persona scaffolding CLI

---

## Best Practices

1. **Keep Chat Default**: Unless persona explicitly needs custom UI
2. **Progressive Enhancement**: Build on existing conversation model
3. **API-First**: Separate data endpoints from UI rendering
4. **Responsive Design**: All specialized UIs must work on mobile
5. **Accessibility**: Maintain WCAG AA compliance
6. **Performance**: Lazy load images, virtualize long lists
7. **Error States**: Handle missing data, failed scans gracefully
8. **Real-Time Updates**: Use WebSockets for live status dashboards

---

## Security Considerations

1. **Image Storage**: Store generated images in user-scoped directories
2. **Path Traversal**: Validate all file paths in repoWatcher findings
3. **RBAC**: Check workspace permissions for specialized UIs
4. **Rate Limiting**: Protect image generation endpoints
5. **CSP Headers**: Configure Content-Security-Policy for custom UIs

---

## Testing Strategy

1. **Unit Tests**: Persona UI type validation
2. **Integration Tests**: API endpoints for each persona type
3. **E2E Tests**: Full user flows for dashboard/gallery
4. **Visual Regression**: Screenshot comparison for UI changes
5. **Performance Tests**: Gallery load time with 100+ images

---

## Open Questions

1. Should personas support multiple UI types simultaneously?
2. How to handle persona UI versioning (breaking UI changes)?
3. Should we build a visual persona UI builder?
4. How to handle third-party persona UIs (plugins)?
5. Should mobile app have different persona UIs?

---

## Next Steps

1. Review and approve this architecture
2. Create PromptConfig migration script
3. Build repoWatcher.html prototype
4. Build imageGen.html prototype
5. Document persona UI creation guide
