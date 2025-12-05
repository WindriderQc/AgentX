# AgentX Authentication System

## Overview

AgentX includes a self-contained authentication system with:
- **Session-based authentication** for web/API users
- **API key authentication** for programmatic access (n8n, automation)
- **Role-based access control** (user/admin)
- **Secure password hashing** with bcrypt
- **MongoDB session storage** for persistence

## Quick Start

### 1. Environment Setup

Add to `.env`:
```bash
# REQUIRED: Session secret (min 32 characters)
SESSION_SECRET=your-random-secret-here

# OPTIONAL: API key for automation
AGENTX_API_KEY=your-secure-api-key
```

### 2. Create First User

**Register endpoint:**
```bash
curl -X POST http://localhost:3080/api/auth/register \
  -H "Content-Type: application/json" \
  -d '{
    "email": "admin@example.com",
    "password": "secure-password",
    "name": "Admin User"
  }'
```

**Response:**
```json
{
  "status": "success",
  "message": "User registered successfully",
  "user": {
    "_id": "...",
    "email": "admin@example.com",
    "name": "Admin User",
    "userId": "admin"
  }
}
```

### 3. Login

```bash
curl -X POST http://localhost:3080/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{
    "email": "admin@example.com",
    "password": "secure-password"
  }' \
  -c cookies.txt
```

Session cookie saved to `cookies.txt` for subsequent requests.

### 4. Access Protected Endpoints

**With session cookie:**
```bash
curl http://localhost:3080/api/auth/me \
  -b cookies.txt
```

**With API key (no session needed):**
```bash
curl http://localhost:3080/api/chat \
  -H "x-api-key: your-api-key"
```

## API Endpoints

### Authentication

| Method | Endpoint | Description | Auth Required |
|--------|----------|-------------|---------------|
| POST | `/api/auth/register` | Register new user | No |
| POST | `/api/auth/login` | Login (creates session) | No |
| POST | `/api/auth/logout` | Logout (destroys session) | Yes |
| GET | `/api/auth/me` | Get current user info | Yes |

### Request/Response Examples

**Register:**
```javascript
POST /api/auth/register
{
  "email": "user@example.com",
  "password": "min-6-chars",
  "name": "User Name" // optional
}

// Success: 201
{
  "status": "success",
  "message": "User registered successfully",
  "user": { "_id": "...", "email": "...", "name": "...", "userId": "..." }
}

// Error: 409 (email exists)
{
  "status": "error",
  "message": "Email already registered"
}
```

**Login:**
```javascript
POST /api/auth/login
{
  "email": "user@example.com",
  "password": "password"
}

// Success: 200 + Set-Cookie header
{
  "status": "success",
  "message": "Login successful",
  "user": { "_id": "...", "email": "...", "name": "...", "isAdmin": false }
}

// Error: 401
{
  "status": "error",
  "message": "Invalid email or password"
}
```

**Logout:**
```javascript
POST /api/auth/logout

// Success: 200
{
  "status": "success",
  "message": "Logged out successfully"
}
```

**Get Current User:**
```javascript
GET /api/auth/me

// Success: 200
{
  "status": "success",
  "user": {
    "_id": "...",
    "email": "user@example.com",
    "name": "User Name",
    "userId": "user",
    "isAdmin": false,
    "preferences": { "theme": "dark", ... }
  }
}

// Error: 401 (not authenticated)
{
  "status": "error",
  "message": "Not authenticated"
}
```

## Protecting Routes

### Using Middleware

```javascript
const { requireAuth, requireAdmin, apiKeyAuth } = require('./src/middleware/auth');

// Require session authentication
router.get('/protected', requireAuth, (req, res) => {
  // res.locals.user is available
  res.json({ user: res.locals.user });
});

// Require admin role
router.delete('/admin/users/:id', requireAuth, requireAdmin, (req, res) => {
  // Only admins can access
});

// Accept API key authentication
router.post('/api/chat', apiKeyAuth, (req, res) => {
  // Automation tools use this
});
```

### Middleware Functions

| Middleware | Purpose | Blocks? |
|------------|---------|---------|
| `attachUser` | Loads user from session | No (runs on all requests) |
| `requireAuth` | Requires session login | Yes (401 if not logged in) |
| `requireAdmin` | Requires admin role | Yes (403 if not admin) |
| `apiKeyAuth` | Requires `x-api-key` header | Yes (401 if invalid key) |
| `optionalAuth` | Allows both session and API key | No (enhances if present) |

## API Key Authentication

For automation tools (n8n, scripts):

**Setup:**
1. Add `AGENTX_API_KEY` to `.env`
2. Use `apiKeyAuth` middleware on endpoints
3. Send `x-api-key` header with requests

**Example:**
```bash
curl http://localhost:3080/api/chat \
  -H "x-api-key: your-api-key" \
  -H "Content-Type: application/json" \
  -d '{"message": "Hello"}'
```

**n8n Integration:**
```javascript
// In n8n HTTP Request node:
Headers:
  x-api-key: {{$env.AGENTX_API_KEY}}
```

## User Model

### Schema

```javascript
{
  userId: String,      // Unique identifier (e.g., "admin")
  name: String,        // Display name
  email: String,       // Unique, for login
  password: String,    // Hashed with bcrypt
  isAdmin: Boolean,    // Role flag (default: false)
  about: String,       // User memory/bio
  preferences: {
    theme: String,
    defaultModel: String,
    customInstructions: String
  },
  createdAt: Date,
  updatedAt: Date,
  lastLogin: Date
}
```

### Making a User Admin

```javascript
// In MongoDB
db.userprofiles.updateOne(
  { email: "admin@example.com" },
  { $set: { isAdmin: true } }
)
```

Or programmatically:
```javascript
const user = await UserProfile.findOne({ email: 'admin@example.com' });
user.isAdmin = true;
await user.save();
```

## Security Features

### Password Security
- **Minimum length:** 6 characters (configurable)
- **Hashing:** bcrypt with salt (10 rounds)
- **Pre-save hook:** Automatic hashing on password change
- **Compare method:** Timing-safe comparison

### Session Security
- **Storage:** MongoDB (persists across restarts)
- **Cookie name:** `agentx.sid`
- **HTTPOnly:** Yes (prevents XSS)
- **Secure:** Yes in production (HTTPS only)
- **SameSite:** `none` in production (CORS), `lax` in dev
- **Max age:** 24 hours (configurable)

### API Key Security
- **Environment variable:** Never commit to repo
- **Header-based:** Not in URLs or query params
- **Constant-time comparison:** Prevents timing attacks
- **Logged:** All API key attempts logged

## Session Management

### Configuration

```javascript
// In server.js
app.use(session({
  secret: process.env.SESSION_SECRET,
  name: 'agentx.sid',
  resave: false,
  saveUninitialized: false,
  store: mongoStore,  // Persists in MongoDB
  cookie: {
    maxAge: 1000 * 60 * 60 * 24,  // 24 hours
    httpOnly: true,
    secure: IN_PROD,
    sameSite: IN_PROD ? 'none' : 'lax'
  }
}));
```

### Session Data

```javascript
// What's stored in session
{
  userId: "507f1f77bcf86cd799439011",  // MongoDB ObjectId
  cookie: { ... }
}
```

### Access in Routes

```javascript
router.get('/profile', (req, res) => {
  // Via middleware (preferred)
  const user = res.locals.user;
  
  // Or directly
  const userId = req.session.userId;
});
```

## Frontend Integration

### Login Form

```javascript
// Login function
async function login(email, password) {
  const response = await fetch('/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',  // Important: send cookies
    body: JSON.stringify({ email, password })
  });
  
  const data = await response.json();
  
  if (data.status === 'success') {
    // Store user info in state/localStorage
    localStorage.setItem('user', JSON.stringify(data.user));
    // Redirect to app
    window.location.href = '/';
  } else {
    // Show error
    alert(data.message);
  }
}
```

### Authenticated Requests

```javascript
// All subsequent requests automatically include session cookie
async function getConversations() {
  const response = await fetch('/api/conversations', {
    credentials: 'include'  // Send cookies
  });
  return response.json();
}
```

### Check Auth Status

```javascript
async function checkAuth() {
  const response = await fetch('/api/auth/me', {
    credentials: 'include'
  });
  
  if (response.ok) {
    const data = await response.json();
    return data.user;
  }
  return null;
}
```

### Logout

```javascript
async function logout() {
  await fetch('/api/auth/logout', {
    method: 'POST',
    credentials: 'include'
  });
  
  localStorage.removeItem('user');
  window.location.href = '/login';
}
```

## Troubleshooting

### "Not authenticated" errors

**Problem:** Session not persisted across requests

**Solutions:**
1. Ensure `credentials: 'include'` in fetch calls
2. Check CORS allows credentials
3. Verify `SESSION_SECRET` is set in `.env`
4. Check MongoDB session store is connected

### Sessions not persisting

**Problem:** Session lost after server restart

**Check:**
```javascript
// Verify session store is MongoDB (not memory)
const store = new MongoDBStore({ uri: MONGODB_URI, ... });
app.use(session({ store, ... }));
```

### API key not working

**Problem:** 401 with API key header

**Debug:**
```bash
# Check environment variable
echo $AGENTX_API_KEY

# Test with curl
curl -v http://localhost:3080/api/chat \
  -H "x-api-key: your-key"

# Check logs
tail -f logs/combined.log | grep "API key"
```

### CORS issues

**Problem:** Cookies not sent from frontend

**Solution:**
```javascript
// In server.js
app.use(cors({
  origin: 'http://your-frontend-domain.com',
  credentials: true  // Allow credentials
}));

// In frontend
fetch('/api/auth/login', {
  credentials: 'include'  // Required
});
```

## Migration Guide

### From No Auth to Auth

1. **Add environment variables:**
   ```bash
   SESSION_SECRET=random-32-char-secret
   AGENTX_API_KEY=your-api-key
   ```

2. **Restart server** to load session middleware

3. **Create admin user:**
   ```bash
   curl -X POST http://localhost:3080/api/auth/register \
     -H "Content-Type: application/json" \
     -d '{"email":"admin@example.com","password":"password","name":"Admin"}'
   ```

4. **Set admin flag in MongoDB:**
   ```javascript
   db.userprofiles.updateOne(
     { email: "admin@example.com" },
     { $set: { isAdmin: true } }
   )
   ```

5. **Protect routes gradually:**
   ```javascript
   // Start with optional auth (doesn't break existing)
   router.get('/conversations', optionalAuth, handler);
   
   // Then enforce when ready
   router.get('/conversations', requireAuth, handler);
   ```

### Backward Compatibility

Existing users without `email` or `password` fields can continue using the system. They won't be able to login via session but can:
- Use API key authentication
- Be manually migrated to add email/password

## Production Checklist

- [ ] Set strong `SESSION_SECRET` (min 32 chars)
- [ ] Set secure `AGENTX_API_KEY`
- [ ] Set `NODE_ENV=production`
- [ ] Use HTTPS in production
- [ ] Configure CORS properly
- [ ] Create admin user
- [ ] Test session persistence
- [ ] Test API key auth
- [ ] Monitor logs for auth errors
- [ ] Set up session cleanup (MongoDB TTL index)

## Next Steps

- Add rate limiting (prevent brute force)
- Add password reset flow
- Add email verification
- Add 2FA support
- Add OAuth providers (Google, GitHub)
- Add user management UI

---

**Architecture inspired by:** DataAPI/SBQC authentication system  
**Security model:** Session-based (web) + API key (automation)  
**Storage:** MongoDB (sessions + users)
