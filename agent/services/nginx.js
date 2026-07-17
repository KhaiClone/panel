const { exec } = require("child_process");
const util = require("util");
const fs = require("fs");
const path = require("path");
const execAsync = util.promisify(exec);

// Port of the panel's nginxService for the agent VPS. The agent runs as root,
// so files are written directly (no sudo). Panel-self config generation is
// intentionally omitted — the panel only reverse-proxies itself locally.

const NGINX_SITES = "/etc/nginx/sites-enabled";

const configPath = (pm2Name) => path.join(NGINX_SITES, `panel-${pm2Name}.conf`);

const reloadNginx = async () => {
    await execAsync("nginx -s reload");
};

// ─── Config generators ────────────────────────────────────────────────────────

// Static sites without domain are served by http-server (PM2), not nginx.
// This config is only written when a domain is assigned to a static site.
const buildStaticConfig = ({ distFolder, domain, extraConfig }) => {
    const extra = extraConfig?.trim() ? `\n${extraConfig.trim()}\n` : "";
    return `server {
    listen 80;
    server_name ${domain};
    root ${distFolder};
    index index.html;

    location / {
        try_files $uri $uri/ /index.html;
    }
${extra}
    gzip on;
    gzip_types text/plain text/css application/json application/javascript text/xml application/xml application/xml+rss text/javascript;
}
`;
};

const buildFullstackConfig = ({ port, apiPort, distFolder, domain, extraConfig }) => {
    const gzip = `    gzip on;
    gzip_types text/plain text/css application/json application/javascript text/xml application/xml application/xml+rss text/javascript;`;

    const makeBlock = (listenPort, serverName, includeExtra = false) => {
        const extra = includeExtra && extraConfig?.trim() ? `\n${extraConfig.trim()}\n` : "";
        return `server {
    listen ${listenPort};
    server_name ${serverName};
    root ${distFolder};
    index index.html;

    location /api {
        proxy_pass http://127.0.0.1:${apiPort};
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_cache_bypass $http_upgrade;
    }

    location / {
        try_files $uri $uri/ /index.html;
    }
${extra}
${gzip}
}`;
    };

    // Always expose on the configured port (accessible by IP:port) — no extra config here
    let config = makeBlock(port, "_", false) + "\n";

    // If a domain is configured, also add a block on port 80 for domain access
    if (domain) {
        config += "\n" + makeBlock(80, domain, true) + "\n";
    }

    return config;
};

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Write (or overwrite) the nginx config for a website project and reload nginx.
 * Validates with `nginx -t` before reloading; restores the previous config
 * (or removes the new one) when validation fails.
 *
 * @param {string} pm2Name
 * @param {Object} opts - { mode, port, apiPort, distFolder, domain, extraConfig }
 */
const writeConfig = async (pm2Name, opts) => {
    const content = opts.mode === "static"
        ? buildStaticConfig(opts)
        : buildFullstackConfig(opts);

    const destPath = configPath(pm2Name);
    let previous = null;
    try { previous = fs.readFileSync(destPath, "utf8"); } catch { /* new config */ }

    fs.writeFileSync(destPath, content, "utf8");

    try {
        await execAsync("nginx -t");
    } catch (err) {
        // Roll back so a broken config never lingers in sites-enabled
        if (previous !== null) fs.writeFileSync(destPath, previous, "utf8");
        else fs.rmSync(destPath, { force: true });
        const detail = (err.stderr || err.message || "").trim().split("\n").slice(0, 4).join(" | ");
        throw new Error(`nginx config test failed: ${detail}`);
    }

    await reloadNginx();
};

/**
 * Remove the nginx config for a project and reload nginx.
 */
const removeConfig = async (pm2Name) => {
    try {
        fs.rmSync(configPath(pm2Name), { force: true });
        await reloadNginx();
    } catch { /* nginx might not be running */ }
};

/** Returns true if the nginx config file exists for this project. */
const configExists = (pm2Name) => {
    try {
        fs.accessSync(configPath(pm2Name), fs.constants.F_OK);
        return true;
    } catch {
        return false;
    }
};

/** pm2Names of every panel-managed config present on this node. */
const listConfigs = () => {
    try {
        return fs.readdirSync(NGINX_SITES)
            .filter((f) => f.startsWith("panel-") && f.endsWith(".conf"))
            .map((f) => f.slice("panel-".length, -".conf".length));
    } catch {
        return [];
    }
};

/**
 * Run certbot to issue/renew SSL for the given domain.
 * Requires certbot and nginx to be installed, and the domain to point to this node.
 *
 * @param {string} domain
 * @param {string|null} email - Contact email for Let's Encrypt (recommended)
 */
const enableSSL = async (domain, email = null) => {
    const emailFlag = email
        ? `-m ${email} --agree-tos`
        : "--register-unsafely-without-email --agree-tos";
    await execAsync(
        `certbot --nginx -d ${domain} ${emailFlag} --non-interactive`,
        { timeout: 120_000 },
    );
};

module.exports = { writeConfig, removeConfig, configExists, listConfigs, enableSSL, reloadNginx };
