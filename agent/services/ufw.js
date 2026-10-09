const { exec } = require("child_process");
const util = require("util");
const net = require("net");
const execAsync = util.promisify(exec);

// UFW management, owned entirely by the agent. Works as root (no
// prefix) or as a regular user with passwordless sudo.

const IS_ROOT = typeof process.getuid === "function" && process.getuid() === 0;
const SUDO = IS_ROOT ? "" : "sudo ";

/** Open a TCP port in UFW. */
const openPort = async (port) => {
    await execAsync(`${SUDO}ufw allow ${port}/tcp`);
};

/** Remove a UFW rule for a TCP port. Errors are silenced (rule may not exist). */
const closePort = async (port) => {
    try {
        await execAsync(`${SUDO}ufw delete allow ${port}/tcp`);
    } catch { /* rule may not exist */ }
};

/** Interface names ufw accepts after "in on" (Linux caps them at 15 chars). */
const IFACE_RE = /^[a-zA-Z0-9_.-]{1,15}$/;

/** Marks every rule allowFrom adds, so they can be found and removed again. */
const PANEL_ACCESS = "bot-panel: panel access";

/**
 * The ufw rule text for allowFrom. `iface` narrows it to traffic arriving on
 * that interface — "wg0" for a peer's WireGuard address. Callers validate ip,
 * port and iface first: the text goes into a shell command.
 */
const allowFromRule = (ip, port, iface = null) =>
    `allow ${iface ? `in on ${iface} ` : ""}from ${ip} to any port ${port} proto tcp comment '${PANEL_ACCESS}'`;

/**
 * Let one IP reach one TCP port — how a node that is about to host the panel is
 * given access to this agent, and how a new node's panel gateway is let through
 * to the panel. Inserted at the top so an earlier DENY for the port cannot
 * shadow it; `ufw insert 1` refuses on an empty rule set, where a plain allow
 * is equivalent anyway.
 */
const allowFrom = async (ip, port, iface = null) => {
    const rule = allowFromRule(ip, port, iface);
    try {
        await execAsync(`${SUDO}ufw insert 1 ${rule}`);
    } catch {
        await execAsync(`${SUDO}ufw ${rule}`);
    }
};

/** Returns true if no process is listening on the given port. */
const isPortFree = (port) =>
    new Promise((resolve) => {
        const server = net.createServer();
        server.once("error", () => resolve(false));
        server.once("listening", () => { server.close(); resolve(true); });
        server.listen(port, "0.0.0.0");
    });

/**
 * Find an available port in [start, end].
 * Throws if no free port is found.
 */
const findFreePort = async (start = 3000, end = 9000) => {
    for (let port = start; port <= end; port++) {
        if (await isPortFree(port)) return port;
    }
    throw new Error(`No free port available in range ${start}–${end}`);
};

/** Raw `ufw status numbered` output. */
const status = async () => {
    const { stdout } = await execAsync(`${SUDO}ufw status numbered`);
    return stdout;
};

/**
 * Numbers of the allowFrom rules whose source is one of `ips`, highest first
 * (deleting in that order leaves the other numbers as they are). Pure: reads
 * `ufw status numbered` lines like
 *   [ 3] 1975/tcp on wg0            ALLOW IN    10.88.0.5                  # bot-panel: panel access
 */
const panelAccessRuleNumbers = (statusText, ips) => {
    const want = new Set(ips);
    const nums = [];
    for (const line of String(statusText).split("\n")) {
        const m = /^\[\s*(\d+)\]\s+(.*?)\s+#\s*(.*?)\s*$/.exec(line);
        if (!m || m[3] !== PANEL_ACCESS) continue;
        const from = m[2].split(/\s{2,}/).pop();
        if (want.has(from)) nums.push(Number(m[1]));
    }
    return nums.sort((a, b) => b - a);
};

// One removal at a time: rule numbers shift with every delete.
let removing = Promise.resolve();

/**
 * Delete the allowFrom rules for these source IPs — when the node behind them
 * leaves the panel. Returns how many went.
 */
const removePanelAccessFrom = (ips) => {
    const run = removing.then(async () => {
        const nums = panelAccessRuleNumbers(await status(), ips);
        for (const n of nums) await execAsync(`${SUDO}ufw --force delete ${n}`);
        return nums.length;
    });
    removing = run.catch(() => {});
    return run;
};

module.exports = {
    openPort,
    closePort,
    allowFrom,
    allowFromRule,
    panelAccessRuleNumbers,
    removePanelAccessFrom,
    IFACE_RE,
    isPortFree,
    findFreePort,
    status,
};
