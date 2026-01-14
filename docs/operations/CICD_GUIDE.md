# CI/CD Pipeline Guide

> **Simple yet comprehensive CI/CD for AgentX**
>
> Last updated: 2026-01-14

---

## 📋 Table of Contents

1. [Overview](#overview)
2. [CI Pipeline (Continuous Integration)](#ci-pipeline)
3. [CD Pipeline (Continuous Deployment)](#cd-pipeline)
4. [Configuration](#configuration)
5. [Troubleshooting](#troubleshooting)
6. [Best Practices](#best-practices)

---

## Overview

AgentX uses a **simple yet powerful** CI/CD setup with GitHub Actions:

- **CI Pipeline** (`.github/workflows/ci.yml`) - Validates every commit
- **CD Pipeline** (`.github/workflows/deploy.yml`) - Deploys to staging/production

### Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                    GitHub Actions                            │
├──────────────────────┬──────────────────────────────────────┤
│   CI Pipeline        │   CD Pipeline                         │
│   (GitHub-hosted)    │   (Self-hosted runner)                │
├──────────────────────┼──────────────────────────────────────┤
│ • Lint & Format      │ • Test                                │
│ • Unit Tests         │ • Backup (MongoDB + Qdrant)           │
│ • Integration Tests  │ • Deploy (git pull + npm ci)          │
│ • Security Scan      │ • Health Check                        │
│ • E2E Tests (PRs)    │ • Rollback on Failure                 │
│ • Summary Report     │ • Slack Notifications                 │
└──────────────────────┴──────────────────────────────────────┘
```

---

## CI Pipeline

**File:** `.github/workflows/ci.yml`

### Triggers

```yaml
on:
  push:
    branches: [main, develop, feature/**, claude/**]
  pull_request:
    branches: [main, develop]
```

### Jobs (6 total - streamlined from 8!)

#### 1. 🎨 **Lint & Format**
```bash
Duration: ~30s
Runs: Always
```

**What it does:**
- Runs ESLint on all `.js` files
- Checks Prettier formatting on `js`, `json`, `md` files
- **FAILS** if code style violations found

**Local test:**
```bash
npm run lint
npx prettier --check "**/*.{js,json,md}"
```

---

#### 2. 🧪 **Unit Tests**
```bash
Duration: ~1-2 min
Runs: Always (parallel with lint)
```

**What it does:**
- Runs all unit tests via `npm run test:unit`
- Checks for open handles (memory leaks)
- Uploads coverage to Codecov (optional)

**Local test:**
```bash
npm run test:unit
npm run test:ci  # with open handles detection
```

---

#### 3. 🔗 **Integration Tests**
```bash
Duration: ~2-3 min
Runs: After unit tests pass
Requires: MongoDB service
```

**What it does:**
- Spins up MongoDB 6 container
- Runs integration tests with real database
- Tests RAG system, chat service, models

**Local test:**
```bash
# Ensure MongoDB is running
npm run test:integration
```

---

#### 4. 🔒 **Security Scan**
```bash
Duration: ~1 min
Runs: Always (parallel with tests)
```

**What it does:**
- Runs `npm audit` for production dependencies
- Scans for committed secrets with TruffleHog
- Reports vulnerabilities (doesn't block by default)

**Local test:**
```bash
npm audit --production --audit-level=high
```

---

#### 5. 🎭 **E2E Tests** (Conditional)
```bash
Duration: ~3-5 min
Runs: Only on PRs to main
Requires: MongoDB service
```

**What it does:**
- Starts full AgentX server
- Runs end-to-end test suite (`test-all.sh`)
- Tests real API endpoints

**Condition:**
```yaml
if: github.event_name == 'pull_request' && github.base_ref == 'main'
```

**Local test:**
```bash
npm run test:e2e
```

---

#### 6. 📊 **CI Summary**
```bash
Duration: ~5s
Runs: Always (after all jobs)
```

**What it does:**
- Collects all job results
- Prints summary table
- **FAILS** if any critical job failed

---

### CI Flow Diagram

```
┌─────────────┐
│  Git Push   │
└──────┬──────┘
       │
       ├──────────────────────────────────────┐
       │                                      │
       ▼                                      ▼
┌─────────────┐                      ┌──────────────┐
│  🎨 Lint    │                      │ 🧪 Unit Test │
│  (~30s)     │                      │  (~1-2 min)  │
└──────┬──────┘                      └──────┬───────┘
       │                                    │
       │                                    ▼
       │                            ┌──────────────┐
       │                            │ 🔗 Integration│
       │                            │  (~2-3 min)  │
       │                            └──────┬───────┘
       │                                   │
       ▼                                   │
┌─────────────┐                           │
│ 🔒 Security │◄──────────────────────────┘
│  (~1 min)   │
└──────┬──────┘
       │
       ▼
┌─────────────┐
│ 📊 Summary  │
│  (always)   │
└─────────────┘
       │
       ▼
    ✅ PASS / ❌ FAIL
```

---

## CD Pipeline

**File:** `.github/workflows/deploy.yml`

### Triggers

```yaml
on:
  push:
    branches: [main, develop]
  workflow_dispatch:
    inputs:
      environment: [staging, production]
```

### Environments

| Environment | Branch | Port | PM2 Process | URL |
|-------------|--------|------|-------------|-----|
| **Production** | `main` | 3080 | `agentx` | http://192.168.2.33:3080 |
| **Staging** | `develop` | 3081 | `agentx-staging` | http://192.168.2.33:3081 |

---

### Deployment Flow

#### **Production Deployment** (`main` branch)

```
1. 🧪 Run Tests (GitHub-hosted)
   ├─ npm ci
   └─ npm test

2. 🏠 Deploy to Self-Hosted Runner (192.168.2.33)
   │
   ├─ 📂 Set Deploy Path
   │  └─ Default: /home/yb/codes/AgentX
   │
   ├─ ✅ Verify Directory Exists
   │
   ├─ 💾 Create Backups
   │  ├─ ./scripts/backup-mongodb.sh
   │  ├─ ./scripts/backup-qdrant.sh
   │  └─ Save current commit to .last_deploy_commit
   │
   ├─ 🔄 Update Code
   │  ├─ git fetch origin main
   │  ├─ git merge origin/main --ff-only
   │  └─ npm ci --prefer-offline --no-audit
   │
   ├─ 🚀 Deploy Application
   │  └─ pm2 reload agentx --update-env
   │
   ├─ 🏥 Health Check (6 attempts, 10s intervals)
   │  └─ curl -f http://localhost:3080/health
   │
   ├─ 📦 Deploy n8n Workflows (optional)
   │  └─ ./scripts/deploy-n8n-workflows.sh
   │
   ├─ 📊 Deployment Summary
   │  └─ Show commit, branch, time, PM2 status
   │
   └─ 🔔 Notify Slack (success)

3. ⚠️ On Failure: Automatic Rollback
   ├─ git reset --hard $(cat .last_deploy_commit)
   ├─ npm ci
   ├─ pm2 reload agentx
   ├─ Verify health
   └─ 🔔 Notify Slack (failure)
```

#### **Staging Deployment** (`develop` branch)

Same flow as production, but:
- Uses `agentx-staging` PM2 process
- Deploys to `/home/yb/codes/AgentX-staging`
- Uses port `3081`
- Uses staging n8n credentials

---

### Manual Deployment

**Via GitHub UI:**

1. Go to **GitHub** → **Actions** tab
2. Click **"🚀 Deploy AgentX"** workflow
3. Click **"Run workflow"** dropdown
4. Select:
   - **Branch:** `main` or `develop`
   - **Environment:** `staging` or `production`
5. Click **"Run workflow"**

**Via Command Line:**

```bash
# Trigger production deployment
gh workflow run deploy.yml --ref main -f environment=production

# Trigger staging deployment
gh workflow run deploy.yml --ref develop -f environment=staging
```

---

## Configuration

### Required Setup

#### 1. **Self-Hosted Runner**

Your server (`192.168.2.33`) must have a GitHub self-hosted runner configured.

**Check if runner is active:**
```bash
# On your server
cd /home/yb/actions-runner
./run.sh --once  # Test run
```

**Verify in GitHub:**
- Go to repo **Settings** → **Actions** → **Runners**
- Should see your runner with status: **Idle** or **Active**

---

#### 2. **GitHub Secrets (Optional)**

**Required for full functionality:**

| Secret Name | Description | Required? |
|-------------|-------------|-----------|
| `AGENTX_DEPLOY_PATH` | Production path | No (defaults to `/home/yb/codes/AgentX`) |
| `AGENTX_STAGING_PATH` | Staging path | No (defaults to `/home/yb/codes/AgentX-staging`) |
| `SLACK_WEBHOOK_URL` | Slack notifications | No |
| `N8N_PROD_URL` | n8n production URL | No |
| `N8N_PROD_KEY` | n8n production API key | No |
| `N8N_STAGING_URL` | n8n staging URL | No |
| `N8N_STAGING_KEY` | n8n staging API key | No |

**How to add secrets:**
1. Go to repo **Settings** → **Secrets and variables** → **Actions**
2. Click **"New repository secret"**
3. Enter name and value
4. Click **"Add secret"**

---

#### 3. **Staging Environment (Optional)**

**Create staging directory:**
```bash
mkdir -p /home/yb/codes/AgentX-staging
cd /home/yb/codes/AgentX-staging

# Clone repository
git clone https://github.com/WindriderQc/AgentX.git .
git checkout develop

# Install dependencies
npm ci

# Configure environment
cp ../.env .env.staging
# Edit .env.staging:
#   - Change PORT=3081
#   - Change MONGODB_URI to separate database
#   - Adjust other settings as needed

# Start with PM2
pm2 start server.js --name agentx-staging --env staging
pm2 save
```

---

### Scripts Required for CD

All scripts are in `./scripts/` directory:

| Script | Purpose | Called By |
|--------|---------|-----------|
| `backup-mongodb.sh` | Backup MongoDB | CD pipeline (pre-deploy) |
| `backup-qdrant.sh` | Backup Qdrant vectors | CD pipeline (pre-deploy) |
| `deploy-n8n-workflows.sh` | Deploy n8n workflows | CD pipeline (post-deploy) |

**Verify scripts exist:**
```bash
ls -la scripts/backup-*.sh scripts/deploy-n8n-workflows.sh
```

---

## Troubleshooting

### CI Pipeline Issues

#### ❌ **Lint fails locally but passes on CI**

**Problem:** Different Prettier versions or configs

**Solution:**
```bash
# Use exact same command as CI
npx prettier --check "**/*.{js,json,md}" --ignore-path .gitignore

# Auto-fix formatting
npm run lint:fix
npx prettier --write "**/*.{js,json,md}" --ignore-path .gitignore
```

---

#### ❌ **Tests pass locally but fail on CI**

**Problem:** Environment differences, missing MongoDB

**Solution:**
```bash
# Run with same env vars
NODE_ENV=test npm test

# Check for open handles
npm run test:ci

# Check integration tests separately
npm run test:integration
```

---

#### ❌ **E2E tests timeout**

**Problem:** Server takes too long to start

**Solution:**
- Check CI logs: does health check endpoint respond?
- Increase wait time in `.github/workflows/ci.yml:202`
- Test locally: `npm run test:e2e`

---

### CD Pipeline Issues

#### ❌ **Self-hosted runner offline**

**Problem:** Runner not connected to GitHub

**Check:**
```bash
# On your server (192.168.2.33)
cd /home/yb/actions-runner
./run.sh --once
```

**Fix:**
```bash
# Restart runner service
sudo systemctl restart actions.runner.*
# OR manually
./run.sh
```

---

#### ❌ **Deployment fails: "directory not found"**

**Problem:** `AGENTX_DEPLOY_PATH` secret points to wrong location

**Fix:**
```bash
# Verify directory exists
ls -la /home/yb/codes/AgentX

# Check GitHub secret value
# Settings → Secrets → AGENTX_DEPLOY_PATH

# Or remove secret to use default
```

---

#### ❌ **Health check fails after deployment**

**Problem:** Application didn't start or crashed

**Debug:**
```bash
# Check PM2 status
pm2 status

# View logs
pm2 logs agentx --lines 100

# Check if port is listening
curl http://localhost:3080/health

# Restart manually
pm2 restart agentx
```

---

#### ❌ **Rollback doesn't work**

**Problem:** `.last_deploy_commit` file not created

**Manual rollback:**
```bash
cd /home/yb/codes/AgentX

# Find last working commit
git log --oneline -10

# Reset to specific commit
git reset --hard <commit-hash>

# Reinstall dependencies
npm ci

# Restart
pm2 reload agentx
```

---

#### ❌ **Backup scripts fail**

**Problem:** Missing backup scripts or permissions

**Fix:**
```bash
# Check scripts exist
ls -la scripts/backup-mongodb.sh scripts/backup-qdrant.sh

# Make executable
chmod +x scripts/backup-*.sh

# Test manually
./scripts/backup-mongodb.sh
```

---

### Common GitHub Actions Errors

#### 🔴 **Error: "Resource not accessible by integration"**

**Problem:** GitHub Actions permissions

**Fix:**
- Go to **Settings** → **Actions** → **General**
- Under "Workflow permissions" select **Read and write permissions**
- Click **Save**

---

#### 🔴 **Error: "No space left on device"**

**Problem:** Self-hosted runner out of disk space

**Fix:**
```bash
# Check disk usage
df -h

# Clean Docker images (if applicable)
docker system prune -af

# Clean old PM2 logs
pm2 flush

# Clean npm cache
npm cache clean --force

# Clean old backups
find /mnt/datalake/backups -mtime +30 -delete
```

---

## Best Practices

### For Development

✅ **Before pushing:**
```bash
# Run linter
npm run lint

# Run tests locally
npm test

# Check formatting
npx prettier --check "**/*.{js,json,md}"
```

✅ **For PRs to main:**
- Ensure all CI checks pass
- E2E tests will run automatically
- Request review before merging

✅ **Branch naming:**
- Features: `feature/my-feature`
- Fixes: `fix/bug-description`
- Chores: `chore/task-description`

---

### For Deployments

✅ **Staging first:**
```bash
# Push to develop branch first
git checkout develop
git merge feature/my-feature
git push origin develop
# → Auto-deploys to staging (:3081)

# Test staging thoroughly
curl http://192.168.2.33:3081/health
# Test features manually

# Then deploy to production
git checkout main
git merge develop
git push origin main
# → Auto-deploys to production (:3080)
```

✅ **Monitor deployments:**
- Watch GitHub Actions tab during deployment
- Check Slack notifications (if configured)
- Verify health endpoint after deployment
- Check PM2 logs for errors

✅ **Emergency rollback:**
```bash
# If automatic rollback fails
cd /home/yb/codes/AgentX
git reset --hard <last-known-good-commit>
npm ci
pm2 reload agentx
```

---

## Summary

### What We Fixed

| Before | After |
|--------|-------|
| 🔴 8 CI jobs (over-engineered) | ✅ 6 CI jobs (streamlined) |
| 🔴 Duplicate CD workflows | ✅ Single CD workflow |
| 🔴 SSH to private IP (broken) | ✅ Self-hosted runner (works) |
| 🔴 No backups | ✅ MongoDB + Qdrant backups |
| 🔴 No rollback | ✅ Automatic rollback |
| 🔴 No health checks | ✅ 6 retries with delays |
| 🔴 Destructive git operations | ✅ Safe merge operations |
| 🔴 Fallback echo commands | ✅ Real failures that block |

---

### Pipeline Performance

**CI Pipeline:** ~3-5 minutes (parallel execution)
**CD Pipeline:** ~2-3 minutes (with backups + health checks)

**Total time from push to deployed:** ~5-8 minutes

---

### Support

**Issues?** Check:
1. [Troubleshooting](#troubleshooting) section above
2. GitHub Actions logs (detailed error messages)
3. PM2 logs: `pm2 logs agentx --lines 200`
4. Server logs: Check for application errors

**Still stuck?** File an issue with:
- Workflow run URL
- Error message from logs
- Steps you've tried
