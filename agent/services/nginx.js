const { exec } = require("child_process");
const util = require("util");
const fs = require("fs");
const path = require("path");
const execAsync = util.promisify(exec);

// nginx vhost management, owned entirely by the agent. Works both as root
// (nothing prefixed) and as a regular user with passwordless sudo (every
// privileged command/file move goes through sudo).

const IS_ROOT = typeof process.getuid === "function" && process.getuid() === 0;
const SUDO = IS_ROOT ? "" : "sudo ";

const NGINX_SITES = "/etc/nginx/sites-enabled";

const configPath = (pm2Name) => path.join(NGINX_SITES, `panel-${pm2Name}.conf`);
// The panel's OWN vhost, separate from any project's config
const PANEL_CONF = path.join(NGINX_SITES, "panel-self.conf");

const reloadNginx = async () => {
    await execAsync(`${SUDO}nginx -s reload`);
};

/** Place `content` at `destPath` (via /tmp + sudo mv when not root). */
const putFile = async (destPath, content) => {
    const tmpPath = `/tmp/agent-nginx-${path.basename(destPath)}`;
    fs.writeFileSync(tmpPath, content, "utf8");
    await execAsync(`${SUDO}mv "${tmpPath}" "${destPath}"`);
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

    await putFile(destPath, content);

    try {
        await execAsync(`${SUDO}nginx -t`);
    } catch (err) {
        // Roll back so a broken config never lingers in sites-enabled
        if (previous !== null) await putFile(destPath, previous).catch(() => {});
        else await execAsync(`${SUDO}rm -f "${destPath}"`).catch(() => {});
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
        await execAsync(`${SUDO}rm -f "${configPath(pm2Name)}"`);
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
 * Why certbot failed, in one line. The CA's verdict ("Type: connection …
 * Detail: 203.0.113.10: Fetching http://…/.well-known/acme-challenge/…: Timeout
 * during connect (likely firewall problem)") goes to stdout, while exec's error
 * message carries only stderr — "Some challenges have failed", which says
 * nothing. Pure, so it is tested without certbot.
 */
const certbotFailure = (domain, { stdout = "", stderr = "", message = "" } = {}) => {
    const out = `${stdout}\n${stderr}`;
    const field = (name) => (out.match(new RegExp(`^\\s*${name}:\\s*(.+)$`, "m")) || [])[1]?.trim() || null;
    const type = field("Type");
    const detail = field("Detail");
    let hint = null;
    if (/Timeout during connect|firewall problem|Connection refused/i.test(out)) {
        hint = "Port 80 of this VPS is not reachable from the internet — on it: sudo ufw allow 80,443/tcp";
    } else if (/DNS problem|NXDOMAIN|no valid A records|SERVFAIL/i.test(out)) {
        hint = `${domain} does not resolve to this VPS yet — point its A record here and wait for DNS`;
    } else if (/unauthorized|Invalid response/i.test(out)) {
        hint = `Another server answered for ${domain} — its DNS points elsewhere, or a proxy in front (Cloudflare) does not pass /.well-known/acme-challenge through`;
    } else if (/too many (certificates|failed authorizations)|rateLimited/i.test(out)) {
        hint = "Let's Encrypt rate limit — wait an hour before trying again";
    }
    if (!type && !detail && !hint) {
        // Not a challenge failure (certbot missing, sudo refused…): the raw error says more.
        return new Error(message.split("\n").filter((l) => !/^Command failed:/.test(l)).join(" ").trim() || message);
    }
    let msg = `certbot could not get a certificate for ${domain}`;
    if (type) msg += ` (${type})`;
    if (detail) msg += `: ${detail}`;
    if (hint) msg += `. ${hint}`;
    return new Error(msg);
};

const runCertbot = async (domain, cmd) => {
    try {
        await execAsync(cmd, { timeout: 120_000 });
    } catch (err) {
        throw certbotFailure(domain, err);
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
    await runCertbot(domain, `${SUDO}certbot --nginx -d ${domain} ${emailFlag} --non-interactive`);
};

/**
 * Reverse-proxy the panel itself on this node. An empty domain list removes the
 * vhost entirely. The generated config is tested with `nginx -t` before the
 * reload; a bad config is rolled back rather than left to break every site on
 * the box.
 */
const writePanelConfig = async (domains, port) => {
    if (!domains || domains.length === 0) {
        await execAsync(`${SUDO}rm -f "${PANEL_CONF}"`).catch(() => {});
        await reloadNginx().catch(() => {});
        return;
    }

    const content = domains
        .map(
            (domain) => `server {
    listen 80;
    server_name ${domain};

    location / {
        proxy_pass http://127.0.0.1:${port};
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_cache_bypass $http_upgrade;
    }
}`,
        )
        .join("\n\n") + "\n";

    await putFile(PANEL_CONF, content);

    try {
        await execAsync(`${SUDO}nginx -t`);
    } catch (err) {
        await execAsync(`${SUDO}rm -f "${PANEL_CONF}"`).catch(() => {});
        const detail = (err.stderr || err.message || "").trim().split("\n").slice(0, 4).join(" | ");
        throw new Error(`nginx config test failed: ${detail}`);
    }

    await reloadNginx();
};

// ─── The panel's own domains, one vhost file per node ──────────────────────────
//
// Each panel domain belongs to one node (its DNS points there). On the node that
// runs the panel it is proxied to the panel; on every other node it redirects to
// wherever the panel runs now. The panel decides which is which and sends the
// whole list; this side only renders it.
//
// HTTPS comes from the certificate on disk, not from certbot editing this file:
// certificates are issued with `certbot certonly` (issuePanelCert), and every
// render adds the 443 block for a domain that has one. Rewriting the file —
// adding a domain, a move flipping proxy ↔ redirect — can therefore never drop
// HTTPS, which the old certbot-edited panel-self.conf did.

const LE_LIVE = "/etc/letsencrypt/live";
const LE_OPTIONS = "/etc/letsencrypt/options-ssl-nginx.conf";
const LE_DHPARAM = "/etc/letsencrypt/ssl-dhparams.pem";

/** /etc/letsencrypt is root-only, so existence is tested through sudo. */
const rootFileExists = async (file) => {
    try {
        await execAsync(`${SUDO}test -f "${file}"`);
        return true;
    } catch {
        return false;
    }
};

const hasCert = (domain) => rootFileExists(`${LE_LIVE}/${domain}/fullchain.pem`);

/**
 * Render panel-self.conf. sites: [{ domain, mode: "proxy", port } | { domain, mode: "redirect", to }]
 * ctx: { certs: Set<domain>, options: bool, dhparam: bool } — what exists on disk.
 * Pure, so it is tested without nginx.
 */
const buildPanelSites = (sites, ctx) => {
    const proxy = (port) => `        proxy_pass http://127.0.0.1:${port};
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_read_timeout 3600s;
        proxy_cache_bypass $http_upgrade;`;
    const body = (s) => (s.mode === "proxy" ? proxy(s.port) : `        return 302 ${s.to}$request_uri;`);

    return sites
        .map((s) => {
            if (!ctx.certs.has(s.domain)) {
                return `server {
    listen 80;
    server_name ${s.domain};

    location / {
${body(s)}
    }
}`;
            }
            // A location-level redirect (not a server-level return) leaves room
            // for the ACME challenge certbot inserts when it renews.
            const extras = [
                ctx.options ? `    include ${LE_OPTIONS};` : null,
                ctx.dhparam ? `    ssl_dhparam ${LE_DHPARAM};` : null,
            ].filter(Boolean).join("\n");
            return `server {
    listen 80;
    server_name ${s.domain};

    location / {
        return 301 https://$host$request_uri;
    }
}

server {
    listen 443 ssl;
    server_name ${s.domain};
    ssl_certificate ${LE_LIVE}/${s.domain}/fullchain.pem;
    ssl_certificate_key ${LE_LIVE}/${s.domain}/privkey.pem;
${extras}

    location / {
${body(s)}
    }
}`;
        })
        .join("\n\n") + "\n";
};

/**
 * Write the panel's vhost for this node (empty list = remove it), test it,
 * reload. A config that fails `nginx -t` is rolled back to the previous file.
 * Returns { certs: [domains with a certificate here] }.
 */
const writePanelSites = async (sites) => {
    if (!sites.length) {
        await execAsync(`${SUDO}rm -f "${PANEL_CONF}"`).catch(() => {});
        await reloadNginx().catch(() => {});
        return { certs: [] };
    }
    const certs = new Set();
    for (const s of sites) if (await hasCert(s.domain)) certs.add(s.domain);
    const content = buildPanelSites(sites, {
        certs,
        options: await rootFileExists(LE_OPTIONS),
        dhparam: await rootFileExists(LE_DHPARAM),
    });

    let previous = null;
    try { previous = fs.readFileSync(PANEL_CONF, "utf8"); } catch { /* none yet */ }
    await putFile(PANEL_CONF, content);
    try {
        await execAsync(`${SUDO}nginx -t`);
    } catch (err) {
        if (previous !== null) await putFile(PANEL_CONF, previous).catch(() => {});
        else await execAsync(`${SUDO}rm -f "${PANEL_CONF}"`).catch(() => {});
        const detail = (err.stderr || err.message || "").trim().split("\n").slice(0, 4).join(" | ");
        throw new Error(`nginx config test failed: ${detail}`);
    }
    await reloadNginx();
    return { certs: [...certs] };
};

/**
 * Issue (or keep) a certificate for a panel domain WITHOUT letting certbot edit
 * nginx files. Needs the domain's port-80 server block (writePanelSites first)
 * and DNS pointing at this node. The deploy hook is saved in the renewal config,
 * so nginx picks up renewed certificates too.
 */
const issuePanelCert = async (domain, email = null) => {
    const emailFlag = email ? `-m ${email} --agree-tos` : "--register-unsafely-without-email --agree-tos";
    await runCertbot(
        domain,
        `${SUDO}certbot certonly --nginx -d ${domain} ${emailFlag} --non-interactive --keep-until-expiring ` +
            `--deploy-hook "nginx -s reload"`,
    );
};

module.exports = {
    writeConfig,
    removeConfig,
    configExists,
    listConfigs,
    enableSSL,
    reloadNginx,
    writePanelConfig,
    buildPanelSites,
    writePanelSites,
    issuePanelCert,
    certbotFailure,
};
