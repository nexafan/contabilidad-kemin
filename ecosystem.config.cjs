// PM2 ecosystem para contabilidad-kemin
// Uso: pm2 start ecosystem.config.cjs
module.exports = {
  apps: [
    {
      name: 'contabilidad-kemin',
      script: 'server.js',
      cwd: '/opt/contabilidad-kemin',
      interpreter: 'node',
      env: {
        NODE_ENV: 'production'
      },
      max_memory_restart: '400M',
      autorestart: true,
      watch: false,
      time: true,
      out_file: '/var/log/contabilidad-kemin.out.log',
      error_file: '/var/log/contabilidad-kemin.err.log'
    }
  ]
};
