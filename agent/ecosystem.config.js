module.exports = {
    apps: [
        {
            name: "panel-agent",
            script: "index.js",
            cwd: __dirname,
            max_memory_restart: "200M",
            env: { NODE_ENV: "production" },
        },
    ],
};
