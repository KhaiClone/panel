const { exec } = require("child_process");
const util = require("util");
const fs = require("fs");
const path = require("path");
const execAsync = util.promisify(exec);

const NGINX_SITES = "/etc/nginx/sites-enabled";

const configPath = (pm2Name) => path.join(NGINX_SITES, `panel-${pm2Name}.conf`);

const reloadNginx = async () => {
    await execAsync("sudo nginx -s reload");
};

// ─── Config generators ────────────────────────────────────────────────────────

// Static sites without domain are served by http-server (PM2), not nginx.
// This config is only written when a domain is assigned to a static site.
const buildStaticConfig = ({ distFolder, domain }) => {
    return `server {
    listen 80;
    server_name ${domain};
    root ${distFolder};
    index index.html;

    location / {
        try_files $uri $uri/ /index.html;
    }

    gzip on;
    gzip_types text/plain text/css application/json application/javascript text/xml application/xml application/xml+rss text/javascript;
}
`;
};

const buildFullstackConfig = ({ port, apiPort, distFolder, domain }) => {
    const gzip = `    gzip on;
    gzip_types text/plain text/css application/json application/javascript text/xml application/xml application/xml+rss text/javascript;`;

    const makeBlock = (listenPort, serverName) => `server {
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

${gzip}
}`;

    // Always expose on the configured port (accessible by IP:port)
    let config = makeBlock(port, "_") + "\n";

    // If a domain is configured, also add a block on port 80 for domain access
    if (domain) {
        config += "\n" + makeBlock(80, domain) + "\n";
    }

    return config;
};

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Write (or overwrite) the nginx config for a website project and reload nginx.
 *
 * @param {string} pm2Name
 * @param {Object} opts - { mode, port, apiPort, distFolder, domain }
 */
const writeConfig = async (pm2Name, opts) => {
    const content = opts.mode === "static"
        ? buildStaticConfig(opts)
        : buildFullstackConfig(opts);

    // Write to /tmp first (panel user has access), then sudo move to nginx dir
    const tmpPath = `/tmp/panel-${pm2Name}.conf`;
    fs.writeFileSync(tmpPath, content, "utf8");
    await execAsync(`sudo mv "${tmpPath}" "${configPath(pm2Name)}"`);
    await reloadNginx();
};

/**
 * Remove the nginx config for a project and reload nginx.
 */
const removeConfig = async (pm2Name) => {
    const p = configPath(pm2Name);
    try {
        await execAsync(`sudo rm -f "${p}"`);
        await reloadNginx();
    } catch { /* nginx might not be running */ }
};

/** Returns true if the nginx config file exists for this project. */
const configExists = (pm2Name) => {
    try {
        // sudo test because the file may not be readable by the panel user
        const { status } = require("child_process").spawnSync("sudo", ["test", "-f", configPath(pm2Name)]);
        return status === 0;
    } catch {
        return false;
    }
};

/**
 * Run certbot to issue/renew SSL for the given domain.
 * Requires certbot and nginx to be installed, and the domain to point to this server.
 *
 * @param {string} domain
 * @param {string|null} email - Contact email for Let's Encrypt (recommended)
 */
const enableSSL = async (domain, email = null) => {
    const emailFlag = email
        ? `-m ${email} --agree-tos`
        : "--register-unsafely-without-email --agree-tos";
    await execAsync(
        `sudo certbot --nginx -d ${domain} ${emailFlag} --non-interactive`,
        { timeout: 120_000 },
    );
};

module.exports = { writeConfig, removeConfig, configExists, enableSSL, reloadNginx };
