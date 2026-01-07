# Models UX Specification

## Overview
This specification details the redesign of the `models.html` interface for AgentX. The goal is to create a unified model catalog that aggregates local Ollama models, cloud LLMs via n8n webhooks, and custom models into a single, cohesive management interface.

## 1. Component Hierarchy
The implementation will follow a component-based architecture (suitable for React or modular HTML/JS).

```plaintext
ModelsPage
├── GlobalNavigation (Sidebar/TopBar)
├── MainContentArea
│   ├── SourcesHeader
│   │   ├── StatisticsSummary (Total Models, Active Hosts, Webhooks)
│   │   └── ActionButtons (Refresh, Add Source)
│   ├── FilterBar
│   │   ├── SearchInput
│   │   ├── ProviderFilter (Ollama, n8n, Custom)
│   │   ├── CategoryFilter (Chat, Code, Vision, Embedding)
│   │   ├── SortDropdown (Name, Size, Parameters, Last Used)
│   │   └── ViewToggle (Grid/List)
│   ├── ModelGrid (or ModelList)
│   │   └── ModelCard
│   │       ├── CardHeader (Icon, Name, Badge)
│   │       ├── CardBody (Params, Size, Format, Description)
│   │       ├── CardFooter (Status, ActionButton, CompareCheckbox)
│   │       └── ContextMenu (Hover actions: Delete, Edit, Benchmark)
│   └── ComparisonDrawer (Collapsible)
│       ├── DrawerHeader (Selected Count, Clear All, Compare Button)
│       └── SelectedModelList
│           └── MiniModelCard (Remove button)
└── Modals
    ├── AddSourceModal
    │   ├── SourceTypeSelector (Ollama / n8n / Custom)
    │   ├── OllamaConfigForm (Host URL, Auth)
    │   ├── N8nConfigForm (Webhook URL, API Key, Alias)
    │   └── CustomModelUpload (Weight files, GGUF linkage)
    ├── ModelDetailModal
    │   ├── DetailHeader
    │   ├── PerformanceMetrics (Latency, throughput charts)
    │   ├── PromptTemplateEditor
    │   └── TestPlayground (Mini chat window)
    ├── DeployModal
    └── ComparisonViewModal (The full side-by-side comparison view)
```

## 2. Detailed Wireframes

### 2.1 Desktop View (1920x1080)
Standard dashboard layout with a sticky comparison drawer at the bottom.

```text
+----------------------------------------------------------------------------------+
|  [Sidebar Nav] |  Models / Catalog                                    [User]     |
|                |                                                                 |
|  Dashboard     |  +-----------------------------------------------------------+  |
|  > Models      |  | [Sources Header]                                          |  |
|  rag           |  | Total: 12 | Local: 8 | Cloud: 4 | [Refresh] [ + Add Source] |  |
|  Settings      |  +-----------------------------------------------------------+  |
|                |                                                                 |
|                |  +-----------------------------------------------------------+  |
|                |  | [Filter Bar]                                              |  |
|                |  | Search: [ Find model... ]  Filter: [Provider v] [Tags v]  |  |
|                |  | Sort: [Last Used v]         View: [:: Grid] [= List]      |  |
|                |  +-----------------------------------------------------------+  |
|                |                                                                 |
|                |  +-----------------------+ +-----------------------+ +-------+  |
|                |  | [Ollama] Llama 3 8B   | | [n8n] GPT-4o-Mini     | | [Cus..|  |
|                |  |                       | |                       | |       |  |
|                |  | Params: 8B  Q4_K_M    | | Context: 128k         | |       |  |
|                |  | Size: 4.2GB           | | Cost: $0.15/M tok     | |       |  |
|                |  |                       | |                       | |       |  |
|                |  | <Status: Ready>       | | <Status: Connected>   | |       |  |
|                |  | [Chat] [x] Compare    | | [Chat] [x] Compare    | |       |  |
|                |  +-----------------------+ +-----------------------+ +-------+  |
|                |                                                                 |
|                |  +-----------------------+ +-----------------------+ +-------+  |
|                |  | [Ollama] Mistral 7B   | | [Ollama] CodeLlama    | |       |  |
|                |  | ...                   | | ...                   | |       |  |
|                |  +-----------------------+ +-----------------------+ +-------+  |
|                |                                                                 |
+----------------+-----------------------------------------------------------------+
| [Comparison Drawer ^]  Selected (2/4): [Llama 3 8B (x)] [GPT-4o (x)]  [COMPARE >]|
+----------------------------------------------------------------------------------+
```

### 2.2 Tablet View (768px)
Grid reduces to 2 columns. Comparison drawer becomes a floating action button (FAB) or a minimized bar.

```text
+-------------------------------------------------------------------+
| [HamMenu]  Models Catalog                                [User]   |
+-------------------------------------------------------------------+
| [Stats: 12 Models | 3 Active]             [+ Add]                 |
+-------------------------------------------------------------------+
| [Search...] [Filters v]                                           |
+-------------------------------------------------------------------+
| +-----------------------------+  +-----------------------------+  |
| | [Ollama] Llama 3 8B         |  | [n8n] GPT-4-Turbo           |  |
| | 8B Params | 4.2GB           |  | 128k Context                |  |
| | [Chat] [x] Compare          |  | [Chat] [x] Compare          |  |
| +-----------------------------+  +-----------------------------+  |
|                                                                   |
| +-----------------------------+  +-----------------------------+  |
| | [Custom] Finance-Fin-70B    |  | ...                         |  |
| | ...                         |  |                             |  |
| +-----------------------------+  +-----------------------------+  |
|                                                                   |
+-------------------------------------------------------------------+
| [^] Compare (2) selected                                          |
+-------------------------------------------------------------------+
```

### 2.3 Mobile View (375px)
Single column card list. Filters collapse into a modal or accordion. Comparison is less emphasized, likely hidden in a menu or a sticky bottom bar.

```text
+---------------------------------------+
| [=] Models                     [+]    |
+---------------------------------------+
| [Search inputs...]             [Filter|
+---------------------------------------+
| +-----------------------------------+ |
| | [Ollama] Llama 3 8B               | |
| | Status: Ready • 4.2GB             | |
| | [ Chat ]  [ Add to Compare ]      | |
| +-----------------------------------+ |
|                                       |
| +-----------------------------------+ |
| | [n8n] GPT-4o                      | |
| | Status: Active • API              | |
| | [ Chat ]  [ Add to Compare ]      | |
| +-----------------------------------+ |
+---------------------------------------+
| [^] 2 Models Selected      [Compare>] |
+---------------------------------------+
```

## 3. User Flows

### Flow 1: Discovery → Filter → Compare → Chat
1.  **User lands on page**: Sees mixed list of Ollama and n8n models.
2.  **Filter**: User clicks "Provider" filter -> Selects "Ollama". Grid updates.
3.  **Selection**: User checks "Compare" on *Llama 3* and *Mistral Large*.
4.  **Drawer interaction**: Comparison drawer slides up showing 2 slots filled.
5.  **Comparison**: User clicks "COMPARE >". Modal opens showing side-by-side stats (Latency, throughput, context window).
6.  **Action**: User decides on Llama 3, clicks "Use in Chat" from the model card or comparison view.

### Flow 2: Register n8n Webhook LLM
1.  **Start**: Click "Add Source" button in header.
2.  **Modal**: "Add Source" modal appears. User selects "n8n Webhook" tab.
3.  **Input**:
    *   Form: "Webhook URL" (e.g., `https://n8n.instance/webhook/chat`)
    *   Form: "Model Name" (e.g., "My Custom Agent")
    *   Form: "Context Window" (manual entry or auto-fetch)
4.  **Test**: User clicks "Test Connection". System sends a ping payload to the webhook.
    *   *Success*: "Connection Verified (200 OK)".
    *   *Fail*: "timeout or 500 error".
5.  **Save**: User clicks "Register". Model appears in the main grid with an "n8n" badge.

### Flow 3: Create & Deploy Custom Model
1.  **Start**: Click "Add Source" -> "Custom Model".
2.  **Input**: Upload GGUF file or paste HuggingFace path.
3.  **Config**: Define system prompt, stop sequences, and temperature defaults.
4.  **Action**: Click "Deploy to Ollama Host".
5.  **Select Host**: Dropdown shows active Ollama instances (e.g., "M1 Max" or "Linux Server").
6.  **Progress**: Progress bar shows download/transfer status.
7.  **Completion**: Model card updates status from "Draft" to "Ready".

## 4. Interaction Patterns

| Action | Pattern | Feedback |
|--------|---------|----------|
| **Hover Card** | Slight lift (translateY -4px), shadow increase. | "Quick Actions" (Chat, Settings) appear overlayed or highlighted. |
| **Add to Compare** | Checkbox or toggle switch on card. | Animation of card "flying" to the bottom drawer. Drawer count increments. |
| **Filter Change** | Dropdown selection or pill click. | Grid opacity drops to 0.5s, spinner, then repopulates (or instant client-side filter). |
| **Delete Model** | Context menu -> Delete. | Confirmation Modal ("Are you sure? This deletes files from disk"). |
| **Status Update** | Real-time polling or WebSocket. | Green dot (Ready), Yellow (Loading), Red (Error) on card header. |

## 5. Visual Design System

### Colors
*   **Background**: Dark Slate (`#0f172a`) to Midnight (`#1e293b`) gradients.
*   **Cards**: Semi-transparent dark blue (`rgba(30, 41, 59, 0.7)`) with backdrop blur.
*   **Primary Action**: Blue Gradient (`linear-gradient(135deg, #3b82f6, #2563eb)`).
*   **Secondary Action**: Slate Gray (`#475569`).
*   **Accents**:
    *   *Ollama*: Orange (`#f97316`)
    *   *n8n*: Red/Pink (`#ec4899`)
    *   *Custom*: Purple (`#8b5cf6`)
*   **Status**:
    *   *Ready*: Emerald (`#10b981`)
    *   *Offline*: Gray (`#64748b`)
    *   *Error*: Rose (`#f43f5e`)

### Typography
*   **Font**: 'Space Grotesk' (Headers), 'Inter' or system sans (Body).
*   **H1**: 24px/32px, Bold.
*   **Card Title**: 18px, Medium.
*   **Meta Text**: 13px, Slate-400 (`#94a3b8`).
*   **Code/ID**: 'JetBrains Mono', 12px.

### Spacing & Layout
*   **Grid Gap**: 24px (Desktop), 16px (Mobile).
*   **Card Padding**: 20px.
*   **Border Radius**: 12px (Cards), 8px (Buttons).

## 6. Responsive Breakpoints

| Breakpoint | Layout | Controls |
|------------|--------|----------|
| **Desktop (>1024px)** | 3-4 Columns. Sidebar visible. | Full Toolbar. Comparison drawer expanded. |
| **Tablet (768px - 1024px)** | 2 Columns. Sidebar collapses to icon rail. | Filters condense to "More..." menu. |
| **Mobile (<768px)** | 1 Column. Sidebar hidden (hamburger). | Filters in modal. Comparison is a sticky footer FAB. |

## 7. Accessibility (a11y)

*   **Keyboard Navigation**:
    *   Tab order: Filters -> Grid -> Pagination -> Drawer.
    *   Arrow keys: Navigate within the model grid.
    *   `Esc`: Close modals or comparison drawer.
*   **ARIA Labels**:
    *   Cards: `role="article" aria-label="Llama 3 Model, Provider Ollama"`.
    *   Status Icons: `aria-label="Status: Ready"`.
    *   Buttons: `aria-label="Add Source"`, `aria-label="Remove model from comparison"`.
*   **Color Contrast**:
    *   Ensure text on badges (e.g., "Ollama") has 4.5:1 contrast against bg.
    *   Focus states must use a high-visibility ring (e.g., bright blue outline).
*   **Screen Readers**:
    *   Announce "Comparison list updated" when a model is added.
    *   Announce errors dynamically using `aria-live="polite"`.

## 8. Empty States & Error Handling

### 8.1 No Models Found (Empty Catalog)
*   **Visual**: Large illustration of an empty box or a disconnected wire.
*   **Message**: "No models connected yet."
*   **Action**: Primary buttons for "Connect Ollama Host" and "Add n8n Webhook".
*   **Help**: Link to "Quickstart: Setting up your first model".

### 8.2 Host Unreachable (Ollama)
*   **Visual**: Model card dimmed out with a "Disconnected" overlay icon.
*   **Message**: "Host at 127.0.0.1:11434 is unreachable."
*   **Action**: "Retry Connection" (button) or "Edit Host Configuration".

### 8.3 Webhook Validation Failed (n8n)
*   **Context**: During "Add Source" test.
*   **Messsage**: "Error 502: Bad Gateway from n8n."
*   **Feedback**: Shake animation on input field. Red border. Debug details accordion (showing the raw response).

---
*Created by External Agent for Task Package 1*
