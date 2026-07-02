// PM2 ecosystem config
// Usage: pm2 start ecosystem.config.js
module.exports = {
    apps: [
        {
            // ── Admin Panel Server ─────────────────────
            name: "bot-panel",
            script: "server/index.js",
            cwd: __dirname,
            instances: 1,
            autorestart: true,
            watch: false,
            max_memory_restart: "300M",
            env: {
                NODE_ENV: "production",
            },
        },
    ],
};
