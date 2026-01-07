# Unified Model Catalog UX Specification

**Target Page**: `/models.html`
**Version**: 1.0.0
**Status**: Draft

## 1. Overview & Goals

The goal is to transform `models.html` from a static list into a **Unified Model Catalog** that acts as the central command center for all AI models in the AgentX ecosystem.

### Core Problems Solved
- **Fragmentation**: Currently, Ollama models, n8n webhook models, and custom DB models exist in silos.
- **Visibility**: Users cannot easily see which model offers the best performance or context window.
- **Comparison**: No way to compare technical specs (parameters, quantization, speed) side-by-side.

### Key Objectives
1. **Unified View**: Aggregates models from Local Ollama hosts, n8n Cloud Webhooks, and Custom Model registry.
2. **Actionable**: One-click to "Chat with this Model" or "Deploy" (for custom models).
3. **Comparative**: Side-by-side comparison of 2-4 models.

---

## 2. Component Hierarchy

The page is built as a Single Page Application (SPA) structure within the existing vanilla JS framework.

```text
ModelsPage
├── PageHeader
│   ├── Title ("Models")
│   ├── Breadcrumbs (Home > Models)
│   └── GlobalActions
│       ├── "Refresh All Sources" (Syncs with Ollama/n8n)
│       └── "Add Source" Button (Primary CTA)
├── StatsRow
│   ├── Total Models Card
│   ├── Local Storage Card (GB used)
│   └── Memory Usage Card (RAM)
├── FilterBar
│   ├── SearchInput (Name, ID, tags)
│   ├── ProviderSelect (Ollama, n8n, Custom)
│   ├── CategorySelect (Chat, Code, Vision, Embedding)
│   ├── SortSelect (Name, Size, Most Used, Newest)
│   └── ViewToggle (Grid vs. List)
├── ModelGrid (Main Content)
│   ├── LoadingState
│   ├── EmptyState
│   └── ModelCard (Repeated)
│       ├── Header (Icon, Name, "New" badge)
│       ├── TagsRow (Size, Quantization, Family)
│       ├── MetricsRow (Context length, Speed t/s)
│       └── ActionsRow (Chat, Compare, Details)
├── ComparisonDrawer (Fixed Bottom)
│   ├── SelectedModelsList
│   ├── Action: "Compare (n)"
│   └── Action: "Clear All"
└── Modals
    ├── AddSourceModal
    │   ├── Tab: Connect Ollama Host
    │   ├── Tab: Register n8n Webhook
    │   └── Tab: Create Custom Model
    ├── ModelDetailModal
    └── DeployModal
```

---

## 3. Wireframes

### 3.1 Desktop View (1920x1080)

```text
+----------------------------------------------------------------------------------+
|  [Sidebar]    Models > Catalog                               [Refresh] [Add Source] |
+----------------------------------------------------------------------------------+
|                                                                                  |
|  [ Total: 12 Models ]   [ Storage: 45GB/512GB ]   [ RAM: 16GB Free ]             |
|                                                                                  |
|  [ Search models...       ] [ Provider v ] [ Task v ] [ Sort v ]  [Grid] [List]  |
|                                                                                  |
+----------------------------------------------------------------------------------+
|                                                                                  |
|  +---------------------+   +---------------------+   +---------------------+     |
|  | (o) Llama 3 8B      |   | (n) GPT-4 Turbo     |   | (c) CodeWizard v2   |     |
|  | [Ollama: Local]     |   | [n8n Webhook]       |   | [Custom: Registry]  |     |
|  |                     |   |                     |   |                     |     |
|  | [Tag: Chat] [Q4_K]  |   | [Tag: Reason]       |   | [Tag: Code] [Q5]    |     |
|  |                     |   |                     |   |                     |     |
|  | Context: 8k tokens  |   | Context: 128k       |   | Context: 16k        |     |
|  | Speed: 45 t/s       |   | Speed: --           |   | Speed: 32 t/s       |     |
|  |                     |   |                     |   |                     |     |
|  | [Chat] [Compare(+)] |   | [Chat] [Compare(+)] |   | [Deploy] [Edit]     |     |
|  +---------------------+   +---------------------+   +---------------------+     |
|                                                                                  |
|  +---------------------+   +---------------------+   +---------------------+     |
|  | ...                 |   | ...                 |   | ...                 |     |
|  +---------------------+   +---------------------+   +---------------------+     |
|                                                                                  |
+----------------------------------------------------------------------------------+
| [Comparison Drawer] Selected: Llama 3 8B, GPT-4 Turbo           [Compare (2)] [X]|
+----------------------------------------------------------------------------------+
```

### 3.2 Mobile View (375px)

```text
+--------------------------------+
| Models            [+] [Search] |
+--------------------------------+
| [ Filter ] [ Sort ]            |
+--------------------------------+
|                                |
| +----------------------------+ |
| | (o) Llama 3 8B             | |
| | [Chat] [8k]       [Local]  | |
| |                            | |
| | [ Chat ]  [ ... More     ] | |
| +----------------------------+ |
|                                |
| +----------------------------+ |
| | (n) GPT-4 Turbo            | |
| | [Reason] [128k]   [Cloud]  | |
| |                            | |
| | [ Chat ]  [ ... More     ] | |
| +----------------------------+ |
|                                |
+--------------------------------+
| Compare (2) selected       [^] |
+--------------------------------+
```

---

## 4. User Flows

### Flow 1: Discovery & Chat
1.  **User enters Models page.**
2.  **Filter**: User types "coding" in search or selects "Code" category.
3.  **Visual Feedback**: Grid instantly filters to show `DeepSeek-Coder` and `CodeLlama`.
4.  **Selection**: User clicks "Chat" on `DeepSeek-Coder`.
5.  **Navigation**: Redirects to `/chat` with `model=deepseek-coder` pre-selected.

### Flow 2: Comparison
1.  **Select**: User clicks "Compare (+)" on `Llama 3`. Button toggles to `[✓] Added`.
2.  **Feedback**: Comparison Drawer slides up: "1 Model Selected".
3.  **Select**: User clicks "Compare (+)" on `Mistral 7B`.
4.  **Feedback**: Drawer updates: "2 Models Selected".
5.  **Action**: User clicks "Compare (2)" in the drawer.
6.  **Navigation**: Overlay or new route opens showing side-by-side spec sheet (Context window, quantization level, file size, license).

### Flow 3: Registering n8n Webhook
1.  **Initiate**: Click "Add Source" -> Select "n8n Webhook" tab.
2.  **Input forms**:
    -   **Name**: "My GPT-4 Workflow"
    -   **Webhook URL**: Paste from n8n.
    -   **Context Limit**: Enter manually (e.g., 128000).
3.  **Test**: Click "Test Connection". Backend pings n8n webhook (expects 200 OK).
4.  **Save**: Click "Register".
5.  **Result**: New card appears in grid with `(n)` icon/badge.

---

## 5. Visual Design System

### Colors (Theme Variables)
- **Background**: `var(--bg-body)`
- **Card Background**: `var(--bg-card)` (slightly lighter than body)
- **Primary Action**: `var(--accent)` (Blue/Cyan gradient)
- **Secondary Action**: `var(--bg-surface-2)`
- **Borders**: `var(--border-color)`

### Source Badges
- **Ollama**: Oranges/Yellows (`#fb923c`) - Represents local compute heat.
- **n8n**: Pinks/Reds (`#ea580c` to `#ec4899`) - n8n brand colors.
- **Custom**: Indigos/Purples (`#6366f1`) - Represents engineered/custom logic.

### Typography
- **Headings**: `Space Grotesk` (matches existing app).
- **Body**: `Inter` or System Sans.
- **Code/Specs**: `JetBrains Mono` or Monospace (for params size "7B", quantization "Q4_K_M").

---

## 6. Implementation Notes

### State Management
Use a simple global store or module:
```javascript
const ModelsStore = {
  sources: [],
  filters: { search: '', tags: [] },
  selection: new Set(),
  
  // Methods
  fetchModels(),
  registerWebhook(url, meta),
  toggleSelection(id)
};
```

### API Endpoints Required (Check existing)
- `GET /api/ollama/models` (Existing)
- `GET /api/models` (Unified endpoint needs creation?) -> *Currently aggregation happens on frontend or needs new route.*
- `POST /api/models/webhook` (For registering n8n sources)

### Performance
- Lazy load model icons/logos.
- Debounce search input (300ms).
- Cache model list in `localStorage` with 5-minute expiry to keep load instant.
