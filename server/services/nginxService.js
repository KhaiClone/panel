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

const buildStaticConfig = ({ port, distFolder, domain }) => {
    const serverName = domain ? `\n    server_name ${domain};` : "";
    return `server {
    listen ${port};${serverName}
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
    const serverName = domain ? `\n    server_name ${domain};` : "";
    return `server {
    listen ${port};${serverName}
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

    gzip on;
    gzip_types text/plain text/css application/json application/javascript text/xml application/xml application/xml+rss text/javascript;
}
`;
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

    fs.writeFileSync(configPath(pm2Name), content, "utf8");
    await reloadNginx();
};

/**
 * Remove the nginx config for a project and reload nginx.
 */
const removeConfig = async (pm2Name) => {
    const p = configPath(pm2Name);
    if (fs.existsSync(p)) {
        fs.unlinkSync(p);
        try { await reloadNginx(); } catch { /* nginx might not be running */ }
    }
};

/** Returns true if the nginx config file exists for this project. */
const configExists = (pm2Name) => fs.existsSync(configPath(pm2Name));

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
