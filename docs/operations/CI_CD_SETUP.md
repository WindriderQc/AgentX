# CI/CD Pipeline Setup Guide

**Date:** January 1, 2026  
**Status:** ✅ Production Ready

## Overview

AgentX uses a **local-deployment CI/CD pipeline** with GitHub Actions that automatically deploys to the local machine on every push to `main`.

### Pipeline Architecture

```
Push to main
     ↓
┌────────────────┐
│  🧪 Test Job   │  (GitHub-hosted runner)
│  Jest tests    │
└───────┬────────┘
        ↓
┌──────────────────┐
│ 🏠 Local Deploy  │
│  AgentX Machine  │
│ (Self-hosted)    │
│  192.168.2.33    │
└──────────────────┘
```

## Features

✅ **Test-First Deployment** - No deployment without passing tests  
✅ **Zero-Downtime** - Uses `pm2 reload` instead of `pm2 restart`  
✅ **Reproducible Builds** - Uses `npm ci` for consistent dependencies  
✅ **Safe Updates** - Git stash preserves local changes before reset  
✅ **Automatic PM2 Setup** - Creates PM2 process if not exists  

## Workflow Jobs

### 1. Test Job (🧪)
- **Runner:** GitHub-hosted Ubuntu
- **Duration:** ~30-60 seconds
- **Actions:**
  - Checkout code
  - Setup Node.js 18 with npm cache
  - Install dependencies (`npm ci`)
  - Run test suite (`npm test`)
  - Gate for deployment

### 2. Local Deploy (🏠)
- **Runner:** Self-hosted (AgentX machine)
- **Target:** 192.168.2.33:3080
- **Duration:** ~20-30 seconds
- **Actions:**
  - Checkout code locally
  - Navigate to deployment directory
  - Backup current state (`git stash`)
  - Pull latest code (`git reset --hard origin/main`)
  - Clean install (`npm ci`)
  - Reload/Start PM2 service (zero-downtime)

## Self-Hosted Runner Setup

### Installation Steps

1. **Create runner directory:**
   ```bash
   cd /home/yb/codes/AgentX
   mkdir actions-runner && cd actions-runner
   ```

2. **Download runner package:**
   ```bash
   curl -o actions-runner-linux-x64-2.330.0.tar.gz -L \
     https://github.com/actions/runner/releases/download/v2.330.0/actions-runner-linux-x64-2.330.0.tar.gz
   ```

3. **Verify and extract:**
   ```bash
   echo "af5c33fa94f3cc33b8e97937939136a6b04197e6dadfcfb3b6e33ae1bf41e79a  actions-runner-linux-x64-2.330.0.tar.gz" | shasum -a 256 -c
   tar xzf ./actions-runner-linux-x64-2.330.0.tar.gz
   ```

4. **Configure runner:**
   ```bash
   ./config.sh --url https://github.com/WindriderQc/AgentX --token [YOUR_TOKEN]
   # Follow prompts:
   # - Runner group: Default
   # - Runner name: agentx
   # - Labels: agentx (in addition to defaults)
   # - Work folder: _work
   ```

5. **Install as systemd service:**
   ```bash
   sudo ./svc.sh install
   sudo ./svc.sh start
   sudo ./svc.sh status
   ```

### Runner Management

**Check status:**
```bash
sudo systemctl status actions.runner.WindriderQc-AgentX.agentx.service
```

**View logs:**
```bash
journalctl -u actions.runner.WindriderQc-AgentX.agentx.service -f
```

**Control service:**
```bash
cd /home/yb/codes/AgentX/actions-runner
sudo ./svc.sh stop|start|restart|status
```

**Remove runner:**
```bash
sudo ./svc.sh stop
sudo ./svc.sh uninstall
./config.sh remove --token [YOUR_TOKEN]
```

## GitHub Secrets Configuration

Optional secrets in repository settings:

| Secret | Description | Default |
|--------|-------------|---------|
| `AGENTX_DEPLOY_PATH` | Custom deployment path | `/home/yb/codes/AgentX` |

**Configure at:** https://github.com/WindriderQc/AgentX/settings/secrets/actions

## Monitoring Deployments

### GitHub Actions Dashboard
🔗 https://github.com/WindriderQc/AgentX/actions

### PM2 Status
```bash
pm2 status agentx
pm2 logs agentx
```

### Runner Logs
```bash
journalctl -u actions.runner.WindriderQc-AgentX.agentx.service -f
```

## Troubleshooting

### Tests Failing
- Check test logs in GitHub Actions
- Run tests locally: `npm test`
- Verify MongoDB connection
- Check Ollama service: `systemctl status ollama`
- Verify Qdrant is accessible

### Local Deployment Fails
- Check runner status: `sudo systemctl status actions.runner.*`
- Verify runner is connected to GitHub
- Check deployment path in workflow
- View runner logs: `journalctl -u actions.runner.* -f`
- Verify PM2 is installed: `which pm2`

### Runner Not Picking Up Jobs
- Verify runner is online in GitHub repo settings
- Check network connectivity
- Restart runner service: `sudo ./svc.sh restart`
- Check for runner updates

### PM2 Issues
- Check if PM2 is running: `pm2 list`
- View PM2 logs: `pm2 logs agentx --lines 50`
- Reset PM2: `pm2 delete agentx && pm2 start server.js --name agentx`
- Save PM2 config: `pm2 save`

## Dependencies

AgentX requires the following services to be running:

1. **MongoDB** (localhost:27017 or remote)
2. **Ollama** with required models:
   ```bash
   ollama pull llama3
   ollama pull nomic-embed-text
   ```
3. **Qdrant** (embedded or external)
4. **PM2** Process Manager

See [DEPLOYMENT.md](DEPLOYMENT.md) for complete service setup.

## Best Practices

### Before Committing
1. ✅ Run tests locally: `npm test`
2. ✅ Check for errors: `npm run test:watch`
3. ✅ Review changes: `git diff`
4. ✅ Meaningful commit messages

### Monitoring
1. 📊 Watch GitHub Actions during deployment
2. 🔍 Check PM2 logs after deployment: `pm2 logs agentx`
3. 🌐 Verify application is accessible at http://192.168.2.33:3080
4. 📝 Monitor error logs in `logs/` directory

### Maintenance
1. 🔄 Keep runner updated (check for new versions monthly)
2. 🧹 Clean up old runner logs: `journalctl --vacuum-time=30d`
3. 📈 Monitor disk space in runner work directory
4. 🔧 Restart services if needed: `pm2 restart agentx`

## Workflow File Location

`.github/workflows/deploy.yml`

## Related Documentation

- [DEPLOYMENT.md](DEPLOYMENT.md) - Complete deployment guide
- [README.md](README.md) - Project overview
- [DataAPI CI_CD_SETUP.md](../DataAPI/CI_CD_SETUP.md) - Related pipeline

## Multi-Repository Runner Setup

This machine runs **two separate runners**:

| Repository | Service Name | Runner Name | Port |
|------------|--------------|-------------|------|
| DataAPI | `actions.runner.WindriderQc-DataAPI.AgentX.service` | AgentX | 3003 |
| AgentX | `actions.runner.WindriderQc-AgentX.agentx.service` | agentx | 3080 |

**Check all runners:**
```bash
sudo systemctl status actions.runner.*
```

## Changelog

### 2026-01-01 - Initial CI/CD Setup
- ✅ Added test job before deployment
- ✅ Implemented local deployment with self-hosted runner
- ✅ Zero-downtime deployments with PM2
- ✅ Automatic PM2 process creation
- ✅ Updated .gitignore for runner artifacts

---

**Maintained by:** WindriderQc  
**Last Updated:** January 1, 2026
