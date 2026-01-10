# n8n API Setup Guide

## Quick Setup

### 1. Access n8n Instance

```bash
# Local access
http://192.168.2.199:5678

# Public access (via Cloudflare Tunnel)
https://n8n.specialblend.icu
```

### 2. Enable API Access

**Via n8n UI:**
1. Login to n8n
2. Click your profile (top-right)
3. Go to **Settings** → **API**
4. Toggle **"API enabled"** to ON
5. Click **"Generate API Key"**
6. Copy the key (you'll only see it once!)

**Via n8n Environment Variables:**

If running n8n in Docker, add to your docker-compose.yml or docker run command:

```yaml
environment:
  - N8N_API_KEY_AUTH_ENABLED=true
  - N8N_API_KEY_AUTH_DEFAULT_KEY=your-secure-api-key-here
```

### 3. Configure Local Environment

Add to `~/.bashrc` or `~/.zshrc`:

```bash
# n8n API Configuration
export N8N_URL="http://192.168.2.199:5678"
export N8N_API_KEY="n8n_api_YOUR_KEY_HERE"  # Replace with your actual key
```

Apply changes:
```bash
source ~/.bashrc
```

### 4. Test API Access

```bash
# Using environment variable
curl -H "X-N8N-API-KEY: $N8N_API_KEY" http://192.168.2.199:5678/api/v1/workflows

# Or directly
curl -H "X-N8N-API-KEY: n8n_api_YOUR_KEY" http://192.168.2.199:5678/api/v1/workflows
```

Expected response:
```json
{
  "data": [
    {
      "id": "1",
      "name": "SBQC - N1.1 System Health Check",
      "active": true,
      ...
    }
  ]
}
```

## Alternative: Use Session Auth

If API key auth is not enabled, you can use session-based authentication:

```bash
# 1. Login and get session cookie
curl -c cookies.txt -X POST http://192.168.2.199:5678/rest/login \
  -H "Content-Type: application/json" \
  -d '{"email":"your@email.com","password":"your-password"}'

# 2. Use cookie for subsequent requests
curl -b cookies.txt http://192.168.2.199:5678/api/v1/workflows
```

## Docker: Check n8n Configuration

```bash
# SSH to n8n host
ssh ubundocker

# Check n8n container
docker ps | grep n8n

# View n8n logs
docker logs n8n

# Check environment variables
docker inspect n8n | jq '.[0].Config.Env'

# Access n8n shell
docker exec -it n8n sh
```

## Enable API via Docker Restart

If you need to enable API via environment variables:

```bash
# SSH to n8n host (192.168.2.199)
ssh ubundocker

# Edit docker-compose.yml or add to docker run:
docker run -d \
  --name n8n \
  -p 5678:5678 \
  -e N8N_BASIC_AUTH_ACTIVE=true \
  -e N8N_BASIC_AUTH_USER=admin \
  -e N8N_BASIC_AUTH_PASSWORD=your-password \
  -e N8N_API_KEY_AUTH_ENABLED=true \
  -v ~/.n8n:/home/node/.n8n \
  n8nio/n8n

# Or update existing container
docker stop n8n
docker rm n8n
# Then run with new environment variables
```

## Security Best Practices

1. **Never commit API keys** to Git
2. Use `.env` files or secret management
3. Restrict API access to trusted IPs
4. Rotate API keys regularly
5. Use HTTPS in production (already set up with Cloudflare Tunnel)

## Common Issues

### Issue: 401 Unauthorized
**Solution:** API key is invalid or not set
```bash
# Check if key is set
echo $N8N_API_KEY

# Regenerate key in n8n UI
```

### Issue: 404 Not Found on /api/v1/workflows
**Solution:** API may not be enabled
- Check n8n version (API added in v0.190.0+)
- Enable API in Settings

### Issue: Connection Refused
**Solution:** n8n service not running
```bash
ssh ubundocker
docker ps | grep n8n
docker start n8n  # if stopped
```

## API Reference

Full n8n API documentation: https://docs.n8n.io/api/

### Key Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/v1/workflows` | List all workflows |
| GET | `/api/v1/workflows/:id` | Get workflow by ID |
| POST | `/api/v1/workflows` | Create workflow |
| PUT | `/api/v1/workflows/:id` | Update workflow |
| DELETE | `/api/v1/workflows/:id` | Delete workflow |
| POST | `/api/v1/workflows/:id/activate` | Activate workflow |
| POST | `/api/v1/workflows/:id/deactivate` | Deactivate workflow |

## Next Steps

Once API access is configured:

```bash
# 1. Test connectivity
./scripts/deploy-n8n-workflows.sh --check

# 2. Deploy fixed N3.1 workflow
./scripts/deploy-n8n-workflows.sh N3.1.json

# 3. Deploy all workflows
./scripts/deploy-n8n-workflows.sh
```
