const path = require("path");
const os = require("os");
const { execFile } = require("child_process");
const util = require("util");
const execFileAsync = util.promisify(execFile);

// ─────────────────────────────────────────────────────────────────────────────
//  Removing this agent from its machine, when the panel removes the node.
//
//  agent/uninstall-agent.sh does the work, for the user this agent runs as. It
//  is started with --detach: it checks it may run (never on the node that runs
//  the panel), then goes on in a systemd unit of its own and returns. It has
//  to — it deletes this agent's PM2 process, and stopping the user's PM2
//  service kills everything that service started, a child of the agent too.
//  From then on it reports to the panel itself (--report), not through here.
// ─────────────────────────────────────────────────────────────────────────────

const SCRIPT = path.join(__dirname, "..", "uninstall-agent.sh");
const IS_ROOT = typeof process.getuid === "function" && process.getuid() === 0;

// What the panel may ask to remove, and the flag that keeps it otherwise.
// --keep-packages first: a script from before the other flags reads only $2.
const KEEP_FLAGS = [
    ["packages", "--keep-packages"],
    ["ssh", "--keep-ssh-keys"],
    ["firewall", "--keep-firewall"],
];
const PARTS = KEEP_FLAGS.map(([part]) => part);
const DOMAIN_RE = /^[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+$/;

const badRequest = (message) => Object.assign(new Error(message), { status: 400 });

/**
 * The script's arguments (after its path). Pure, so it is tested without a
 * machine to uninstall. `parts` are what to remove beyond the agent itself.
 */
const scriptArgs = ({ user, parts = [], reportUrl = null, certs = [] }) => {
    if (!user || !/^[a-z_][a-z0-9_.-]*\$?$/i.test(user)) throw badRequest("Invalid user name");
    if (!Array.isArray(parts) || parts.some((p) => !PARTS.includes(p))) {
        throw badRequest(`parts must be a list of: ${PARTS.join(", ")}`);
    }
    const args = [user];
    for (const [part, flag] of KEEP_FLAGS) if (!parts.includes(part)) args.push(flag);
    if (!Array.isArray(certs) || certs.some((d) => typeof d !== "string" || !DOMAIN_RE.test(d))) {
        throw badRequest("certs must be a list of domain names");
    }
    for (const d of certs) args.push("--cert", d);
    if (reportUrl) {
        let u;
        try { u = new URL(reportUrl); } catch { throw badRequest("Invalid reportUrl"); }
        if (!["http:", "https:"].includes(u.protocol) || /\s/.test(reportUrl)) throw badRequest("Invalid reportUrl");
        args.push("--report", reportUrl);
    }
    return args;
};

/**
 * Start the detached uninstall → { detail } (the unit, or the pid without
 * systemd). The script's refusal comes back as a 409 with its own words.
 */
const start = async ({ parts, reportUrl, certs }) => {
    const args = [SCRIPT, ...scriptArgs({ user: os.userInfo().username, parts, reportUrl, certs }), "--detach"];
    // A non-root agent may run bash through sudo (setup-agent.sh's sudoers entry).
    const [cmd, argv] = IS_ROOT ? ["bash", args] : ["sudo", ["-n", "bash", ...args]];
    try {
        const { stdout } = await execFileAsync(cmd, argv, { timeout: 60_000 });
        const m = /^Detached: (.+)$/m.exec(stdout);
        return { detail: m ? m[1] : stdout.trim() };
    } catch (err) {
        const said = String(err.stderr || err.stdout || err.message).trim().split("\n").filter(Boolean).slice(-3).join(" ");
        throw Object.assign(new Error(`uninstall-agent.sh did not start: ${said}`), { status: 409 });
    }
};

module.exports = { scriptArgs, start, PARTS };
