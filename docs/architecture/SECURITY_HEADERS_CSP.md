# Security Headers & Content Security Policy (CSP)

**Status:** ✅ Implemented (Week 3 Day 9)
**Date:** 2026-01-06

---

## Overview

AgentX implements production-grade security headers using [Helmet.js](https://helmetjs.github.io/), including strict Content Security Policy (CSP), HSTS, and additional protective headers.

**Key Principle:** Security headers are **environment-aware**:
- **Production:** Full Helmet with strict CSP, HSTS, frame protection
- **Development:** Basic headers only (for local network compatibility)

---

## Security Headers Enabled

### Production Mode (`NODE_ENV=production`)

| Header | Value | Purpose |
|--------|-------|---------|
| **Content-Security-Policy** | See CSP Directives below | Prevent XSS, injection attacks |
| **Strict-Transport-Security** | `max-age=31536000; includeSubDomains; preload` | Force HTTPS, prevent downgrade attacks |
| **X-Content-Type-Options** | `nosniff` | Prevent MIME-type sniffing |
| **X-Frame-Options** | `DENY` | Prevent clickjacking |
| **X-XSS-Protection** | `1; mode=block` | Enable browser XSS filter |
| **Referrer-Policy** | `strict-origin-when-cross-origin` | Control referrer information |
| **X-Powered-By** | *(removed)* | Hide server technology |

### Development Mode (`NODE_ENV=development`)

| Header | Value | Purpose |
|--------|-------|---------|
| **X-Content-Type-Options** | `nosniff` | Prevent MIME-type sniffing |
| **X-Frame-Options** | `DENY` | Prevent clickjacking |
| **X-XSS-Protection** | `1; mode=block` | Enable browser XSS filter |
| **Referrer-Policy** | `strict-origin-when-cross-origin` | Control referrer information |

---

## Content Security Policy (CSP) Directives

```javascript
contentSecurityPolicy: {
  directives: {
    defaultSrc: ["'self'"],
    scriptSrc: ["'self'", "'unsafe-inline'", "https://cdn.jsdelivr.net"],
    styleSrc: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
    fontSrc: ["'self'", "https://fonts.gstatic.com"],
    imgSrc: ["'self'", "data:", "https:"],
    connectSrc: ["'self'"],
    objectSrc: ["'none'"],
    baseUri: ["'self'"],
    formAction: ["'self'"],
    frameAncestors: ["'none'"],
    upgradeInsecureRequests: []
  }
}
```

### Directive Breakdown

#### `defaultSrc: ["'self'"]`
**Purpose:** Default policy for all resource types
**Effect:** Only allow resources from same origin unless overridden

---

#### `scriptSrc: ["'self'", "'unsafe-inline'", "https://cdn.jsdelivr.net"]`
**Purpose:** Control JavaScript execution
**Allowed Sources:**
- `'self'` - Same origin scripts (`/js/chat.js`, etc.)
- `'unsafe-inline'` - Inline `<script>` tags (⚠️ TODO: Remove)
- `https://cdn.jsdelivr.net` - External CDN for marked.js, Chart.js

**Why 'unsafe-inline'?**
AgentX currently uses inline event handlers (`onclick`, `onload`) and inline scripts. This weakens CSP protection.

**Roadmap to Remove 'unsafe-inline':**
1. Extract all inline scripts to external `.js` files
2. Replace inline event handlers with `addEventListener()`
3. Use CSP nonces for remaining inline scripts
4. Remove `'unsafe-inline'` from CSP

---

#### `styleSrc: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"]`
**Purpose:** Control CSS loading
**Allowed Sources:**
- `'self'` - Same origin styles (`/styles.css`, etc.)
- `'unsafe-inline'` - Inline `<style>` tags and `style=` attributes (⚠️ TODO: Remove)
- `https://fonts.googleapis.com` - Google Fonts CSS

**Why 'unsafe-inline'?**
AgentX uses inline `style="..."` attributes for dynamic styling.

**Roadmap to Remove 'unsafe-inline':**
1. Move inline styles to CSS classes
2. Use CSS variables for dynamic values
3. Use CSP nonces for critical inline styles
4. Remove `'unsafe-inline'` from CSP

---

#### `fontSrc: ["'self'", "https://fonts.gstatic.com"]`
**Purpose:** Control font loading
**Allowed Sources:**
- `'self'` - Local fonts
- `https://fonts.gstatic.com` - Google Fonts files

---

#### `imgSrc: ["'self'", "data:", "https:"]`
**Purpose:** Control image loading
**Allowed Sources:**
- `'self'` - Same origin images
- `data:` - Base64-encoded images (e.g., avatars)
- `https:` - Any HTTPS image (user avatars, external content)

**Note:** `https:` is permissive but necessary for user-generated content (avatars, RAG documents with images)

---

#### `connectSrc: ["'self'"]`
**Purpose:** Control AJAX, WebSocket, SSE connections
**Allowed Sources:**
- `'self'` - Same origin API calls (`/api/chat`, `/api/rag`, etc.)

**External Ollama Hosts:**
If `OLLAMA_HOST` or `OLLAMA_HOST_SECONDARY` point to external servers (not localhost), add their origins:
```javascript
connectSrc: [
  "'self'",
  process.env.OLLAMA_HOST ? new URL(process.env.OLLAMA_HOST).origin : null
].filter(Boolean)
```

---

#### `objectSrc: ["'none'"]`
**Purpose:** Prevent plugins (Flash, Java, etc.)
**Effect:** Block all `<object>`, `<embed>`, `<applet>` tags

---

#### `baseUri: ["'self'"]`
**Purpose:** Restrict `<base>` tag URLs
**Effect:** Prevent base tag injection attacks

---

#### `formAction: ["'self'"]`
**Purpose:** Control form submission targets
**Effect:** Forms can only submit to same origin

---

#### `frameAncestors: ["'none'"]`
**Purpose:** Control embedding in frames/iframes
**Effect:** Equivalent to `X-Frame-Options: DENY` (prevent clickjacking)

---

#### `upgradeInsecureRequests: []`
**Purpose:** Force HTTPS
**Effect:** Browser automatically upgrades HTTP requests to HTTPS

---

## HSTS Configuration

**Header:**
```
Strict-Transport-Security: max-age=31536000; includeSubDomains; preload
```

**Parameters:**
- `max-age=31536000` - 1 year (browsers remember HTTPS requirement)
- `includeSubDomains` - Apply to all subdomains
- `preload` - Eligible for browser preload lists

**Preload List Submission:**
https://hstspreload.org/

**Requirements for Preload:**
1. Serve valid HTTPS certificate
2. Redirect HTTP → HTTPS
3. Serve HSTS header on base domain
4. `max-age` ≥ 31536000 (1 year)
5. `includeSubDomains` present
6. `preload` present

---

## Testing Security Headers

### 1. Manual Testing (Dev Environment)

```bash
# Start AgentX in dev mode
NODE_ENV=development npm start

# Check dev headers
curl -I http://localhost:3080

# Expected headers:
# X-Content-Type-Options: nosniff
# X-Frame-Options: DENY
# X-XSS-Protection: 1; mode=block
# Referrer-Policy: strict-origin-when-cross-origin
# (No CSP, no HSTS)
```

---

### 2. Manual Testing (Production Simulation)

```bash
# Start AgentX in production mode
NODE_ENV=production npm start

# Check production headers
curl -I http://localhost:3080

# Expected headers:
# Content-Security-Policy: default-src 'self'; script-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net; ...
# Strict-Transport-Security: max-age=31536000; includeSubDomains; preload
# X-Content-Type-Options: nosniff
# X-Frame-Options: DENY
# X-XSS-Protection: 1; mode=block
# Referrer-Policy: strict-origin-when-cross-origin
# (No X-Powered-By)
```

---

### 3. Browser DevTools Testing

**Test CSP Violations:**

1. Open Chrome DevTools (F12) → Console tab
2. Navigate to AgentX UI
3. Look for CSP violation warnings:
   ```
   Refused to load the script 'https://example.com/evil.js' because it violates the following Content Security Policy directive: "script-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net"
   ```

**Test Security Headers:**

1. DevTools → Network tab
2. Reload page
3. Click on main document request
4. Headers → Response Headers
5. Verify presence of:
   - `content-security-policy`
   - `strict-transport-security` (production only)
   - `x-content-type-options`
   - `x-frame-options`

---

### 4. Security Scanner Testing

**SecurityHeaders.com:**
```bash
# Deploy to public server, then test:
https://securityheaders.com/?q=https://yourdomain.com
```

**Expected Grade:** A (with current CSP)
**To achieve A+:** Remove `'unsafe-inline'` from CSP

---

**Mozilla Observatory:**
```bash
https://observatory.mozilla.org/analyze/yourdomain.com
```

**Expected Score:** 80-90/100

---

**OWASP ZAP:**
```bash
# Run automated security scan
docker run -t owasp/zap2docker-stable zap-baseline.py -t http://localhost:3080
```

**Expected:** No critical/high findings related to headers

---

### 5. PM2 Production Testing

```bash
# Deploy to PM2 with production environment
NODE_ENV=production pm2 reload ecosystem.config.js --only agentx --update-env
pm2 save

# Test headers
curl -I http://localhost:3080

# Check PM2 logs for confirmation
pm2 logs agentx --lines 50 | grep "Production security headers enabled"
```

---

## Common CSP Issues & Fixes

### Issue 1: External Ollama Host Blocked

**Symptom:**
```
Refused to connect to 'http://192.168.2.99:11434' because it violates the following Content Security Policy directive: "connect-src 'self'"
```

**Fix:**
Update `connectSrc` in `/src/app.js`:
```javascript
connectSrc: [
  "'self'",
  process.env.OLLAMA_HOST ? new URL(process.env.OLLAMA_HOST).origin : null,
  process.env.OLLAMA_HOST_SECONDARY ? new URL(process.env.OLLAMA_HOST_SECONDARY).origin : null
].filter(Boolean)
```

---

### Issue 2: Inline Scripts Blocked (After Removing 'unsafe-inline')

**Symptom:**
```
Refused to execute inline script because it violates the following Content Security Policy directive: "script-src 'self'"
```

**Fix (Nonce-Based):**
1. Generate nonce in middleware:
   ```javascript
   app.use((req, res, next) => {
     res.locals.nonce = crypto.randomBytes(16).toString('base64');
     next();
   });
   ```
2. Add nonce to CSP:
   ```javascript
   scriptSrc: ["'self'", (req, res) => `'nonce-${res.locals.nonce}'`]
   ```
3. Add nonce to inline scripts:
   ```html
   <script nonce="<%= nonce %>">
     // Inline script here
   </script>
   ```

---

### Issue 3: WebSocket Connection Blocked

**Symptom:**
```
Refused to connect to 'ws://localhost:3080' because it violates the following Content Security Policy directive: "connect-src 'self'"
```

**Fix:**
WebSocket connections use `ws://` or `wss://` protocols, which are covered by `connect-src 'self'`. If issue persists, explicitly add:
```javascript
connectSrc: ["'self'", "ws:", "wss:"]
```

---

### Issue 4: Fonts Not Loading

**Symptom:**
Fonts appear as default system fonts, console shows CSP violation

**Fix:**
Ensure `fontSrc` includes the font provider:
```javascript
fontSrc: [
  "'self'",
  "https://fonts.gstatic.com",
  "https://fonts.googleapis.com"
]
```

---

## Security Hardening Roadmap

### Phase 1: Current State (Week 3 Day 9) ✅
- [x] Helmet enabled for production
- [x] Basic CSP with `'unsafe-inline'`
- [x] HSTS with 1-year max-age
- [x] X-Frame-Options: DENY
- [x] Environment-aware headers

### Phase 2: Remove 'unsafe-inline' (Week 4)
- [ ] Extract inline scripts to `/js` files
- [ ] Replace inline event handlers with `addEventListener()`
- [ ] Move inline styles to CSS classes
- [ ] Implement CSP nonces for remaining inline scripts
- [ ] Update CSP to remove `'unsafe-inline'`

### Phase 3: Strict CSP (Week 5)
- [ ] Remove `https:` wildcard from `imgSrc` (use specific domains)
- [ ] Implement Subresource Integrity (SRI) for CDN resources
- [ ] Add `report-uri` for CSP violation reporting
- [ ] Implement CSP in report-only mode before enforcing

### Phase 4: HTTPS Enforcement (Production)
- [ ] Configure HTTPS certificate
- [ ] Redirect HTTP → HTTPS
- [ ] Submit to HSTS preload list
- [ ] Enable `upgradeInsecureRequests`

---

## Environment Variables

```bash
# Enable production security headers
NODE_ENV=production

# Configure external Ollama hosts (if needed for CSP)
OLLAMA_HOST=http://192.168.2.99:11434
OLLAMA_HOST_SECONDARY=http://192.168.2.100:11434

# CORS origins (related to security)
CORS_ORIGINS=https://yourdomain.com,https://www.yourdomain.com
```

---

## Compliance Benefits

### OWASP Top 10 Mitigation

| OWASP Risk | Mitigation | Header |
|------------|------------|--------|
| **A03: Injection** | CSP prevents inline script injection | Content-Security-Policy |
| **A05: Security Misconfiguration** | Strict headers reduce attack surface | Multiple |
| **A07: Cross-Site Scripting (XSS)** | CSP blocks unauthorized scripts | Content-Security-Policy |
| **A07: Cross-Site Scripting (XSS)** | Browser XSS filter enabled | X-XSS-Protection |
| **A08: Software and Data Integrity** | HSTS prevents MITM attacks | Strict-Transport-Security |

---

### Security Frameworks Compliance

**NIST Cybersecurity Framework:**
- PR.AC-5: Protect network integrity (HSTS)
- PR.DS-5: Protect data in transit (HTTPS enforcement)
- DE.CM-1: Detect unauthorized access attempts (CSP violation reporting)

**CIS Controls:**
- 3.10: Encrypt Sensitive Data in Transit (HSTS)
- 7.7: Conduct Application Layer Filtering (CSP)

---

## References

- [Helmet.js Documentation](https://helmetjs.github.io/)
- [MDN: Content Security Policy](https://developer.mozilla.org/en-US/docs/Web/HTTP/CSP)
- [OWASP Secure Headers Project](https://owasp.org/www-project-secure-headers/)
- [CSP Evaluator (Google)](https://csp-evaluator.withgoogle.com/)
- [HSTS Preload List](https://hstspreload.org/)
- [SecurityHeaders.com](https://securityheaders.com/)
- [Mozilla Observatory](https://observatory.mozilla.org/)

---

**Status:** ✅ **IMPLEMENTED**
**Date:** 2026-01-06
**Version:** 1.0
