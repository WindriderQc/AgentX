#!/usr/bin/env node
/**
 * AgentX Host Agent
 *
 * Lightweight system metrics collector that runs on each monitored host.
 * Collects CPU, RAM, GPU, disk, network, and process info, then reports
 * to the AgentX server via HTTP POST.
 *
 * Works on Windows, Linux, and macOS.
 *
 * Usage:
 *   AGENTX_SERVER=http://your-agentx:3000 node agent.js
 *
 * Environment variables:
 *   AGENTX_SERVER       - AgentX server URL (required)
 *   AGENT_TOKEN         - Shared auth token (must match HOST_AGENT_TOKEN on server)
 *   AGENT_INTERVAL_MS   - Collection interval in ms (default: 30000)
 *   AGENT_HOST_ID       - Custom host ID (default: auto-generated from hostname)
 */

const si = require('systeminformation');
const os = require('os');
const http = require('http');
const https = require('https');
const crypto = require('crypto');

// ─── Config ────────────────────────────────────────────────

const SERVER_URL = process.env.AGENTX_SERVER || '';
const AGENT_TOKEN = process.env.AGENT_TOKEN || '';
const INTERVAL_MS = parseInt(process.env.AGENT_INTERVAL_MS, 10) || 30000;
const HOST_ID = process.env.AGENT_HOST_ID || generateHostId();
const VERSION = '1.0.0';

function generateHostId() {
  const hostname = os.hostname();
  const hash = crypto.createHash('md5')
    .update(`${hostname}-${os.platform()}-${os.arch()}`)
    .digest('hex')
    .slice(0, 8);
  return `${hostname}-${hash}`;
}

// ─── Metric collection ────────────────────────────────────

async function collectMetrics() {
  const [
    cpuData, cpuLoad, cpuTemp,
    memData,
    gpuData,
    diskData,
    netInterfaces, netStats,
    osInfo,
    processes
  ] = await Promise.all([
    si.cpu(),
    si.currentLoad(),
    si.cpuTemperature().catch(() => ({ main: null })),
    si.mem(),
    si.graphics().catch(() => ({ controllers: [] })),
    si.fsSize(),
    si.networkInterfaces(),
    si.networkStats().catch(() => []),
    si.osInfo(),
    si.processes().catch(() => ({ list: [] }))
  ]);

  // CPU
  const cpu = {
    model: cpuData.brand || cpuData.manufacturer || '',
    cores: cpuData.cores || os.cpus().length,
    physicalCores: cpuData.physicalCores || 0,
    speed: cpuData.speed || 0,
    usage: Math.round((cpuLoad.currentLoad || 0) * 10) / 10,
    temperature: cpuTemp.main || null,
    loadAvg: os.loadavg().map(v => Math.round(v * 100) / 100)
  };

  // Memory
  const memory = {
    total: memData.total || 0,
    used: memData.used || 0,
    free: memData.free || 0,
    usagePercent: memData.total > 0
      ? Math.round((memData.used / memData.total) * 1000) / 10
      : 0
  };

  // GPUs
  const gpus = (gpuData.controllers || [])
    .filter(g => g.model && g.model !== 'undefined')
    .map((g, i) => ({
      index: i,
      name: g.model || '',
      vramTotal: g.vram || 0,                        // MiB
      vramUsed: g.memoryUsed || 0,                   // MiB (may be 0 on some drivers)
      temperature: g.temperatureGpu || null,
      utilization: g.utilizationGpu || null           // percent (NVIDIA only)
    }));

  // Disks (filter out snap/loop mounts on Linux)
  const disks = (diskData || [])
    .filter(d => d.mount && !d.mount.startsWith('/snap') && d.type !== 'squashfs')
    .map(d => ({
      mount: d.mount,
      fs: d.fs || '',
      type: d.type || '',
      total: d.size || 0,
      used: d.used || 0,
      available: (d.size || 0) - (d.used || 0),
      usagePercent: Math.round((d.use || 0) * 10) / 10
    }));

  // Network (filter loopback and virtual)
  const interfaces = (netInterfaces || [])
    .filter(n => !n.internal && n.operstate === 'up')
    .map(n => {
      const stats = (netStats || []).find(s => s.iface === n.iface) || {};
      return {
        name: n.iface,
        bytesIn: stats.rx_bytes || 0,
        bytesOut: stats.tx_bytes || 0,
        speed: n.speed || null
      };
    });

  // Top processes
  const procList = (processes.list || []).filter(p => p.name);
  const topCpu = procList
    .sort((a, b) => (b.cpu || 0) - (a.cpu || 0))
    .slice(0, 5)
    .map(p => ({ pid: p.pid, name: p.name, cpu: Math.round((p.cpu || 0) * 10) / 10, mem: Math.round((p.mem || 0) * 10) / 10 }));
  const topMem = procList
    .sort((a, b) => (b.mem || 0) - (a.mem || 0))
    .slice(0, 5)
    .map(p => ({ pid: p.pid, name: p.name, cpu: Math.round((p.cpu || 0) * 10) / 10, mem: Math.round((p.mem || 0) * 10) / 10 }));

  // Find local IP
  const primaryNet = (netInterfaces || []).find(n => !n.internal && n.operstate === 'up' && n.ip4);

  return {
    hostId: HOST_ID,
    hostname: os.hostname(),
    platform: os.platform(),
    distro: osInfo.distro || '',
    kernel: osInfo.kernel || '',
    arch: os.arch(),
    ip: primaryNet?.ip4 || '',
    agentVersion: VERSION,
    uptime: os.uptime(),
    cpu,
    memory,
    gpus,
    disks,
    network: { interfaces },
    topProcessesCpu: topCpu,
    topProcessesMem: topMem
  };
}

// ─── HTTP reporter ─────────────────────────────────────────

function sendReport(data) {
  return new Promise((resolve, reject) => {
    const url = new URL('/api/hosts/report', SERVER_URL);
    const isHttps = url.protocol === 'https:';
    const transport = isHttps ? https : http;
    const body = JSON.stringify(data);

    const options = {
      hostname: url.hostname,
      port: url.port || (isHttps ? 443 : 80),
      path: url.pathname,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
        ...(AGENT_TOKEN ? { 'x-agent-token': AGENT_TOKEN } : {})
      },
      timeout: 10000
    };

    const req = transport.request(options, (res) => {
      let responseBody = '';
      res.on('data', chunk => { responseBody += chunk; });
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          resolve(responseBody);
        } else {
          reject(new Error(`Server responded ${res.statusCode}: ${responseBody.slice(0, 200)}`));
        }
      });
    });

    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Request timeout')); });
    req.end(body);
  });
}

// ─── Main loop ─────────────────────────────────────────────

async function tick() {
  try {
    const metrics = await collectMetrics();
    await sendReport(metrics);
    const ts = new Date().toISOString().slice(11, 19);
    console.log(`[${ts}] Reported: CPU ${metrics.cpu.usage}% | RAM ${metrics.memory.usagePercent}% | GPUs ${metrics.gpus.length} | Disks ${metrics.disks.length}`);
  } catch (err) {
    console.error(`[${new Date().toISOString().slice(11, 19)}] Error: ${err.message}`);
  }
}

function main() {
  if (!SERVER_URL) {
    console.error('ERROR: AGENTX_SERVER environment variable is required.');
    console.error('Usage: AGENTX_SERVER=http://your-agentx:3000 node agent.js');
    process.exit(1);
  }

  console.log('━'.repeat(50));
  console.log('AgentX Host Agent v' + VERSION);
  console.log(`  Host ID:  ${HOST_ID}`);
  console.log(`  Server:   ${SERVER_URL}`);
  console.log(`  Interval: ${INTERVAL_MS}ms`);
  console.log(`  Platform: ${os.platform()} ${os.arch()}`);
  console.log('━'.repeat(50));

  // First report immediately, then on interval
  tick();
  setInterval(tick, INTERVAL_MS);
}

main();
