module.exports = {
  apps: [
    {
      name: 'agentx',
      script: './server.js',
      cwd: __dirname,
      instances: process.env.NODE_ENV === 'production' ? 'max' : 1,
      exec_mode: 'cluster',
      watch: false,
      node_args: '--max-old-space-size=2048',
      env: {
        NODE_ENV: 'development'
        // PORT and other vars are read from .env (do not hardcode secrets here)
      },
      env_production: {
        NODE_ENV: 'production'
      },
      error_file: './logs/err.log',
      out_file: './logs/out.log',
      log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
      merge_logs: true,
      max_memory_restart: '2G',
      restart_delay: 4000,
      autorestart: true,
      max_restarts: 10,
      min_uptime: '10s'
    }
    // DataAPI and Qdrant run on 192.168.2.33 (TrueNAS VM), not on this host
  ]
};