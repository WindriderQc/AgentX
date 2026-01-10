# Multi-Repository Runner Management

**Date:** January 1, 2026  
**Machine:** AgentX (192.168.2.33)

## Overview

This machine runs **two GitHub Actions self-hosted runners** for automated CI/CD deployment of DataAPI and AgentX repositories.

## Runner Configuration

| Repository | Service Name | Runner Name | Port | Deploy Path |
|------------|--------------|-------------|------|-------------|
| **DataAPI** | `actions.runner.WindriderQc-DataAPI.AgentX.service` | AgentX | 3003 | `/home/yb/codes/DataAPI` |
| **AgentX** | `actions.runner.WindriderQc-AgentX.agentx.service` | agentx | 3080 | `/home/yb/codes/AgentX` |

## Quick Commands

### Check All Runners
```bash
# Status of all runners
sudo systemctl status actions.runner.*

# List only active status
sudo systemctl status actions.runner.* --no-pager | grep -E "(●|Active:)"
```

### Individual Runner Status
```bash
# DataAPI runner
sudo systemctl status actions.runner.WindriderQc-DataAPI.AgentX.service

# AgentX runner
sudo systemctl status actions.runner.WindriderQc-AgentX.agentx.service
```

### View Logs
```bash
# DataAPI runner logs (live)
journalctl -u actions.runner.WindriderQc-DataAPI.AgentX.service -f

# AgentX runner logs (live)
journalctl -u actions.runner.WindriderQc-AgentX.agentx.service -f

# Last 50 lines of both
journalctl -u actions.runner.* -n 50 --no-pager
```

### Control Services
```bash
# Restart both runners
sudo systemctl restart actions.runner.*

# Stop all runners
sudo systemctl stop actions.runner.*

# Start all runners
sudo systemctl start actions.runner.*
```

### Manual Runner Control (Alternative)
```bash
# DataAPI runner
cd /home/yb/codes/DataAPI/actions-runner
sudo ./svc.sh stop|start|restart|status

# AgentX runner
cd /home/yb/codes/AgentX/actions-runner
sudo ./svc.sh stop|start|restart|status
```

## PM2 Applications

### Check All Apps
```bash
pm2 status
```

### Individual App Management
```bash
# DataAPI
pm2 status data_serv
pm2 logs data_serv
pm2 reload data_serv

# AgentX
pm2 status agentx
pm2 logs agentx
pm2 reload agentx
```

### Restart All
```bash
pm2 restart all
```

## Monitoring Deployments

### GitHub Actions
- **DataAPI:** https://github.com/WindriderQc/DataAPI/actions
- **AgentX:** https://github.com/WindriderQc/AgentX/actions

### Application URLs
- **DataAPI:** http://192.168.2.33:3003
- **AgentX:** http://192.168.2.33:3080

## Troubleshooting

### Runner Not Picking Up Jobs
```bash
# Check runner status
sudo systemctl status actions.runner.*

# Check for errors
journalctl -u actions.runner.* -n 100 --no-pager | grep -i error

# Restart runners
sudo systemctl restart actions.runner.*
```

### Disk Space Issues
```bash
# Check disk usage
df -h

# Clean up old logs
sudo journalctl --vacuum-time=30d

# Clean runner work directories
rm -rf /home/yb/codes/DataAPI/actions-runner/_work/_temp
rm -rf /home/yb/codes/AgentX/actions-runner/_work/_temp
```

### Network Issues
```bash
# Test GitHub connectivity
curl -I https://github.com

# Check DNS
nslookup github.com
```

### Service Won't Start
```bash
# Check for conflicts
sudo systemctl list-units --failed

# View detailed status
sudo systemctl status actions.runner.* -l

# Reinstall service
cd /home/yb/codes/[REPO]/actions-runner
sudo ./svc.sh uninstall
sudo ./svc.sh install
sudo ./svc.sh start
```

## Maintenance Tasks

### Weekly
- ✅ Check runner status: `sudo systemctl status actions.runner.*`
- ✅ Review PM2 apps: `pm2 status`
- ✅ Check disk space: `df -h`

### Monthly
- ✅ Check for runner updates at https://github.com/actions/runner/releases
- ✅ Clean up old logs: `sudo journalctl --vacuum-time=30d`
- ✅ Review and clean PM2 logs: `pm2 flush`

### As Needed
- ✅ Update runner version
- ✅ Rotate credentials
- ✅ Update PM2: `npm install -g pm2@latest`

## Backup & Recovery

### Backup Runner Configuration
```bash
# Backup DataAPI runner
cp /home/yb/codes/DataAPI/actions-runner/.runner ~/backups/runner-dataapi.json
cp /home/yb/codes/DataAPI/actions-runner/.credentials ~/backups/credentials-dataapi

# Backup AgentX runner
cp /home/yb/codes/AgentX/actions-runner/.runner ~/backups/runner-agentx.json
cp /home/yb/codes/AgentX/actions-runner/.credentials ~/backups/credentials-agentx
```

### Recovery Steps
If a runner needs to be reconfigured:

1. Stop and uninstall the service
2. Remove the runner from GitHub
3. Download fresh runner package
4. Configure with new token
5. Reinstall as service

## Security Notes

- ⚠️ Runner tokens are sensitive - never commit them
- ⚠️ Runners have access to deploy code - keep services updated
- ⚠️ Monitor runner logs for suspicious activity
- ⚠️ Keep `.credentials` and `.runner` files secure

## Support

For issues:
1. Check GitHub Actions logs first
2. Check runner service logs
3. Check PM2 application logs
4. Review this guide
5. Check repository-specific CI_CD_SETUP.md files

---

**Last Updated:** January 1, 2026
