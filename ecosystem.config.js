module.exports = {
  apps: [
    {
      name: 'agentx',
      script: './server.js',
      cwd: __dirname,
      instances: 'max',
      exec_mode: 'cluster',
      watch: false,
      node_args: '--max-old-space-size=512',
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
      max_memory_restart: '500M',
      restart_delay: 4000,
      autorestart: true,
      max_restarts: 10,
      min_uptime: '10s'
    },
    {
        name: 'dataapi',
        cwd: '/home/yb/codes/DataAPI',
        script: './data_serv.js',
        instances: process.env.NODE_ENV === 'production' ? 'max' : 1,
        exec_mode: 'cluster',
        watch: false,
        env: {
            NODE_ENV: 'development'
        },
        env_production: {
            NODE_ENV: 'production'
        },
        merge_logs: true,
        max_memory_restart: '500M',
        restart_delay: 4000,
        autorestart: true,
        max_restarts: 10,
        min_uptime: '10s'
    },
    {
        name: 'benchmark',
        cwd: '/home/yb/codes/BenchmarkService',
        script: './server.js',
        instances: 1,
        exec_mode: 'fork',
        watch: false,
        env: {
            NODE_ENV: 'development',
            PORT: 3081
        },
        env_production: {
            NODE_ENV: 'production',
            PORT: 3081
        },
        merge_logs: true,
        max_memory_restart: '200M',
        restart_delay: 4000,
        autorestart: true,
        max_restarts: 10,
        min_uptime: '10s'
    }
  ]
};