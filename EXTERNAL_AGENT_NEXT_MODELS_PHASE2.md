# External Agent Task: Model Catalog Phase 2 - Comparison & Management

## Status
**Phase 1**: ✅ COMPLETE (Unified Model Catalog UI)
**Phase 2**: 📋 READY TO START

## Overview
Build the interactive comparison view and model management features for the unified model catalog.

## Task: Model Comparison & Management UI

### 1. Comparison Modal/Drawer Enhancement

**Current State**: Drawer shows selected models but "Compare Now" is placeholder

**Requirements**:
- Full-screen comparison modal with side-by-side layout
- Show detailed specs for selected models (2-4 models)
- Display comparison metrics:
  - **Performance**: Context length, parameters, quantization
  - **Capabilities**: Tasks, use cases, strengths/weaknesses
  - **Resources**: RAM usage, disk size, recommended hardware
  - **Availability**: Status (running/stopped), provider, download size
- Highlight differences (e.g., "20x larger context" badge)
- Export comparison as PDF/CSV
- "Clear All" and "Remove" individual model buttons

### 2. Add Model Source Modal

**Current State**: "Add Source" button shows alert placeholder

**Requirements**:
- Modal with 3 tabs:
  1. **Pull from Ollama** - Search Ollama library, show popular models, pull button
  2. **Connect n8n** - Form to add n8n instance URL + API key
  3. **Custom Model** - Upload Modelfile or select from registry
- Form validation and loading states
- Success/error notifications
- Auto-refresh model list after successful add

### 3. Model Actions & Management

**Add per-model action menu** (3-dot menu on each card):
- **Start/Stop** (for Ollama models)
- **Test Model** - Quick test chat modal
- **View Details** - Full spec sheet modal
- **Delete** - Confirmation dialog (with data loss warning)
- **Edit** - For custom models only
- **Export Config** - Download model configuration

### 4. Batch Operations

**Add toolbar actions when models are selected**:
- Start All / Stop All (for Ollama)
- Export Selection (as JSON config)
- Delete Selection (with confirmation)
- Tag Management (add/remove tags to multiple models)

### 5. Advanced Filtering

**Enhance filter bar**:
- **Sort by**: Name, Size, Context Length, Date Added, Status
- **View mode toggle**: Grid (current) / Table / Compact list
- **Status filter**: Running, Stopped, All
- **Quick filters**: "Large Context (>32k)", "Fast (<4B params)", "Recommended"
- **Save filter presets** (e.g., "Coding Models", "Production Ready")

### 6. Model Details Modal

**Full specifications view**:
- Header: Model name, provider badge, status indicator
- Tabs:
  1. **Overview**: Description, use cases, capabilities
  2. **Specifications**: Parameters, context, quantization, architecture
  3. **Performance**: Benchmark scores (if available), latency metrics
  4. **Usage**: Example prompts, best practices, limitations
  5. **Activity**: Usage stats, last used, total requests
- Action buttons: Start/Stop, Test, Delete, Export

### 7. Integration Points

**API Endpoints to Use**:
- `GET /api/models/all` - Already working (Phase 1)
- `POST /api/models/pull` - Pull model from Ollama library
- `POST /api/models/ollama/start` - Start Ollama model
- `POST /api/models/ollama/stop` - Stop Ollama model
- `DELETE /api/models/:provider/:id` - Delete model
- `POST /api/n8n-llm-sources` - Add n8n source
- `POST /api/custom-models` - Create custom model
- `GET /api/models/:provider/:id/stats` - Get usage statistics

**Note**: Some endpoints may need to be created in backend if they don't exist.

## Technical Requirements

### Frontend Files
- **Enhance**: `/public/models.html` - Add modals and action menus
- **Enhance**: `/public/js/models-unified.js` - Add comparison, management logic
- **Add**: `/public/js/models-comparison.js` - Comparison modal logic
- **Add**: `/public/js/models-management.js` - CRUD operations
- **Enhance**: `/public/css/styles.css` - Modal styles, animations

### Backend Files (if needed)
- **Check**: `/routes/custom-models.js` - Ensure CRUD endpoints exist
- **Check**: `/routes/ollama.js` - Ensure start/stop endpoints exist
- **Add**: `/routes/model-management.js` - New unified management endpoints

### Design Consistency
- Maintain Glassmorphism aesthetic from Phase 1
- Use existing color palette (Orange=Ollama, Pink=n8n, Indigo=Custom)
- Smooth animations (slide-up drawers, fade-in modals)
- Responsive design (mobile-friendly modals)

## User Experience Flow

### Comparison Flow
1. User selects 2-4 models (checkboxes)
2. Comparison drawer slides up showing mini-cards
3. Click "Compare Now" → Full modal opens
4. Side-by-side comparison with highlighted differences
5. Export as PDF or close modal

### Add Model Flow
1. Click "Add Source" button
2. Modal opens with 3 tabs
3. User chooses tab and fills form
4. Submit → Loading state → Success message
5. Modal closes, model list refreshes with new model

### Model Action Flow
1. Hover over model card → 3-dot menu appears
2. Click action (e.g., "Start")
3. Loading indicator on card
4. Success/error notification
5. Card updates to show new status

## Success Criteria

✅ **Comparison**:
- Can compare 2-4 models side-by-side
- All key metrics displayed with clear differences
- Export to PDF works

✅ **Add Model**:
- Can pull from Ollama library
- Can add n8n source
- Can create custom model

✅ **Management**:
- Can start/stop Ollama models
- Can delete models with confirmation
- Can view full details modal

✅ **Batch Operations**:
- Can select multiple models
- Can perform bulk actions
- Toolbar shows when models selected

✅ **Filtering**:
- Can sort by all criteria
- Can switch view modes
- Quick filters work

## Testing Checklist

- [ ] Comparison modal renders correctly with 2, 3, and 4 models
- [ ] PDF export generates readable comparison document
- [ ] Add model modal validates input correctly
- [ ] Model start/stop actions work (test with Ollama)
- [ ] Delete confirmation prevents accidental deletion
- [ ] Batch operations work with multiple selections
- [ ] All sort options work correctly
- [ ] View mode toggle (grid/table/compact) works
- [ ] Filter presets save/load correctly
- [ ] Details modal shows all tabs with correct data
- [ ] Mobile responsive design (modals work on small screens)

## Notes

- **Priority**: High (builds on successful Phase 1)
- **Estimated Time**: 4-6 hours
- **Dependencies**: Phase 1 complete ✅
- **Backend Work**: May need to create some API endpoints if missing

## Questions to Resolve

1. Should model comparison support more than 4 models at once?
2. Do we need authentication/authorization checks for model management actions?
3. Should we implement model versioning (track model updates)?
4. Do we want real-time status updates (WebSocket) for model start/stop?

---

**Ready to Start**: Yes ✅
**Blockers**: None
**Contact**: Report completion via external agent report format

🚀 **Let's build Phase 2!**
