# PM2 ecosystem file — used for production deployment
# Usage:  pm2 start ecosystem.config.js
#         pm2 save && pm2 startup

module.exports = {
  apps: [
    {
      name: 'shopchat-backend',
      script: './backend/server.js',
      cwd: './',
      instances: 1,
      autorestart: true,
      watch: false,
      max_memory_restart: '512M',
      env_production: {
        NODE_ENV: 'production',
      },
      log_date_format: 'YYYY-MM-DD HH:mm:ss',
      error_file: './backend/logs/pm2-error.log',
      out_file: './backend/logs/pm2-out.log',
    },
  ],
};
