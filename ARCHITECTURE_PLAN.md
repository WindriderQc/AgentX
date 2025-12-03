# AgentX V1 & V2 Implementation Plan

## Context
AgentX is a local AI assistant control board. We are upgrading it to include persistence (V1) and user memory/feedback (V2).
Reference implementation: DataAPI (MongoDB, Express).

## Architecture

### Database (MongoDB)
We will use Mongoose for object modeling.

#### 1. Collections

**`conversations`**
Stores chat sessions.
```javascript
const MessageSchema = new Schema({
  role: { type: String, required: true }, // 'user', 'assistant', 'system'
  content: { type: String, required: true },
  timestamp: { type: Date, default: Date.now },
  feedback: {
    rating: { type: Number, enum: [1, -1, 0], default: 0 }, // 1: thumbs up, -1: thumbs down
    comment: String
  }
});

const ConversationSchema = new Schema({
  userId: { type: String, default: 'default' }, // For future multi-user support
  model: String,
  systemPrompt: String,
  messages: [MessageSchema],
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now }
});
```

**`users`** (or `user_profiles`)
Stores user specific memory and settings.
```javascript
const UserProfileSchema = new Schema({
  userId: { type: String, unique: true, required: true },
  name: String,
  about: String, // "User Memory" - facts about the user
  preferences: {
    theme: String,
    defaultModel: String,
    customInstructions: String
  }
});
```

### API Endpoints

**Chat & Logs**
- `POST /api/chat`:
  - **Input**: `{ message, model, history, options }`
  - **Logic**:
    1. Fetch User Profile.
    2. Inject `User Memory` into System Prompt.
    3. Call Ollama (proxy).
    4. Save `User Message` and `Assistant Response` to `conversations`.
  - **Output**: `{ status: 'success', data: response, conversationId: '...' }`

- `GET /api/history`:
  - **Output**: List of past conversations (summary or full).

- `GET /api/history/:id`:
  - **Output**: Full details of a specific conversation.

**Feedback**
- `POST /api/feedback`:
  - **Input**: `{ conversationId, messageIndex, rating, comment }`
  - **Logic**: Update the specific message in `conversations` collection.

**User Profile**
- `GET /api/profile`:
  - **Output**: User profile JSON.
- `POST /api/profile`:
  - **Input**: `{ name, about, preferences }`
  - **Output**: Updated profile.

## Task Breakdown

### Backend Tasks
1. **Setup**: Install `mongoose`, `dotenv`. Create `config/db.js`.
2. **Models**: Create `models/Conversation.js` and `models/UserProfile.js`.
3. **Endpoints**:
   - Refactor `server.js` to use `express.Router` for cleaner organization (optional but recommended).
   - Implement `routes/chat.js` (Handle chat + memory injection + logging).
   - Implement `routes/history.js` (CRUD for conversations).
   - Implement `routes/profile.js` (CRUD for user profile).
   - Implement `routes/feedback.js` (Update message feedback).

### Frontend Tasks
1. **UI Components**:
   - **Sidebar**: Toggleable sidebar to show Chat History (list of dates/summaries).
   - **Profile Modal**: A settings-like modal to edit "User Memory" (Bio) and Preferences.
   - **Feedback**: Add Thumbs Up/Down icons next to Assistant messages.
2. **Integration**:
   - Update `sendMessage` in `app.js` to call the new `/api/chat`.
   - Load History on startup.
   - Save Profile settings.
   - Handle Feedback clicks.

## Chat Flow (Step-by-Step)
1. **User** types "Hello" and clicks Send.
2. **Frontend** POSTs to `/api/chat` with `{ message: "Hello", model: "llama2", history: [...] }`.
3. **Backend**:
   - Retrieves `UserProfile` (e.g., "User is a software engineer").
   - Appends "User Info: User is a software engineer" to the System Prompt.
   - Calls Ollama API.
   - Receives "Hello! How can I help with your code?".
   - Creates/Updates `Conversation` document: Adds User message and Assistant message.
   - Returns response to Frontend.
4. **Frontend** renders the response.
5. **User** clicks "Thumbs Up".
6. **Frontend** POSTs to `/api/feedback` with `{ conversationId, messageIndex: 5, rating: 1 }`.
7. **Backend** updates the database.
