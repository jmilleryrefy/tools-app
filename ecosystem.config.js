module.exports = {
  apps: [{
    name: 'tools-app',
    cwd: '/home/yrefy-it/tools-app',
    script: 'npm',
    args: 'start',
    env: {
      NODE_ENV: 'production',
      HOSTNAME: '127.0.0.1',
      PORT: 3007
    },
    instances: 1,
    exec_mode: 'fork',
    autorestart: true,
    watch: false,
    max_memory_restart: '1G'
  }]
}
