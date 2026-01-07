# userId String vs ObjectId Audit Report

## Issue Summary
The system has a **systemic issue** where `req.user.userId` contains a username **string** ("yb"), but many models expect an **ObjectId** reference to UserProfile.

## Root Cause
- Session stores: `req.user = { userId: "yb" }` (username string)
- Database stores: `UserProfile { _id: ObjectId('...'), userId: "yb" }`
- Models expect: `userId: ObjectId` (reference to UserProfile._id)

## Fixed Files ✅

### Routes
- ✅ `/routes/workspaces.js` - All 11 endpoints use `getUserProfileId()` helper
- ✅ `/routes/invitations.js` - Uses UserProfile lookup (lines 97, 189)

### Middleware
- ✅ `/src/middleware/workspace.js` - Fixed to use UserProfile ObjectId
- ✅ `/src/middleware/workspaceAudit.js` - Fixed to convert string → ObjectId

### Models
- ✅ `/models/WorkspaceMember.js` - Changed `ref: 'User'` → `ref: 'UserProfile'` (2 places)
- ✅ `/models/Workspace.js` - Changed `ref: 'User'` → `ref: 'UserProfile'` (1 place)
- ✅ `/models/WorkspaceAuditLog.js` - Already uses `ref: 'UserProfile'`

## Remaining Issues ⚠️

### Models Still Referencing 'User' (Non-existent Model)

1. **`/models/FeatureFlag.js`** (Lines 16-17)
   ```javascript
   enabledFor: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
   disabledFor: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
   ```
   **Impact**: Medium - Feature flags won't populate correctly
   **Fix**: Change to `ref: 'UserProfile'`

2. **`/models/N8nLLMSource.js`** (Line 105)
   ```javascript
   createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' }
   ```
   **Impact**: Low - N8n sources rarely queried with populate
   **Fix**: Change to `ref: 'UserProfile'`

3. **`/models/FeatureUsage.js`** (Line 4)
   ```javascript
   userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', index: true }
   ```
   **Impact**: Medium - Analytics queries may fail
   **Fix**: Change to `ref: 'UserProfile'`

4. **`/models/CustomModel.js`** (Line 161)
   ```javascript
   createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' }
   ```
   **Impact**: HIGH - Used in workspace features, will fail populate
   **Fix**: Change to `ref: 'UserProfile'`

5. **`/models/CustomDashboard.js`** (Line 87)
   ```javascript
   createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' }
   ```
   **Impact**: Medium - Dashboard queries may fail
   **Fix**: Change to `ref: 'UserProfile'`

6. **`/models/ActivityLog.js`** (Line 15)
   ```javascript
   userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' }
   ```
   **Impact**: Medium - Activity tracking may fail
   **Fix**: Change to `ref: 'UserProfile'`

### Routes That Need userId → ObjectId Conversion

**Search Pattern**: `req.user.userId` used to **create** or **query** documents

#### Priority 1: HIGH RISK (Creates documents with string userId)
None found after workspace fixes ✅

#### Priority 2: MEDIUM RISK (Queries that might fail)
- `/routes/invitations.js:231` - Only used in logger (safe) ✅
- `/src/middleware/workspace.js:171` - Only used in logger (safe) ✅

#### Priority 3: LOW RISK (Logging only)
- All remaining `req.user.userId` in logs are safe (just string logging)

## Recommended Fix Priority

### IMMEDIATE (Breaking workspace features)
1. ✅ DONE: Fix `/models/WorkspaceMember.js`
2. ✅ DONE: Fix `/models/Workspace.js`
3. ✅ DONE: Fix `/src/middleware/workspaceAudit.js`
4. **TODO**: Fix `/models/CustomModel.js` - Used in workspaces!

### HIGH (Will fail with populate)
5. **TODO**: Fix `/models/FeatureFlag.js`
6. **TODO**: Fix `/models/FeatureUsage.js`
7. **TODO**: Fix `/models/ActivityLog.js`
8. **TODO**: Fix `/models/CustomDashboard.js`

### MEDIUM (May cause issues later)
9. **TODO**: Fix `/models/N8nLLMSource.js`

## Fix Pattern

### For Model Schema References
```javascript
// OLD (broken):
userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' }

// NEW (fixed):
userId: { type: mongoose.Schema.Types.ObjectId, ref: 'UserProfile' }
```

### For Routes Creating Documents
```javascript
// Add helper at top of file:
async function getUserProfileId(sessionUserId) {
  const userProfile = await UserProfile.findOne({ userId: sessionUserId });
  if (!userProfile) {
    throw new Error('User profile not found');
  }
  return userProfile._id;
}

// Use in routes:
const userProfileId = await getUserProfileId(req.user.userId);
// Now use userProfileId (ObjectId) instead of req.user.userId (string)
```

## Testing Checklist

After fixes, test:
- [ ] Custom model creation (workspace feature)
- [ ] Feature flag queries
- [ ] Activity log creation
- [ ] Dashboard creation
- [ ] N8n source creation
- [ ] Feature usage tracking
- [ ] All populate() queries work

## Long-term Solution

**Recommendation**: Update session to store UserProfile ObjectId instead of username string

```javascript
// In authentication middleware:
// OLD:
req.user = { userId: userProfile.userId }; // String "yb"

// NEW:
req.user = {
  userId: userProfile._id,        // ObjectId (for DB queries)
  username: userProfile.userId    // String (for display)
};
```

This would eliminate the need for conversion helpers.

## Status
- **Fixed**: 8 files (workspace core features)
- **Remaining**: 6 model files (secondary features)
- **Risk**: MEDIUM - Secondary features may fail with populate queries

---

**Last Updated**: 2026-01-07
**Next Action**: Fix remaining 6 model files (5 minutes of work)
