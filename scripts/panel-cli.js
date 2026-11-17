#!/usr/bin/env node
/**
 * panel-cli — the owner's access to the panel from a terminal, with a CLI
 * access key (server/services/cliAccess.js) instead of a browser or an SSH key.
 * Made for Claude Code on machines that do not hold the VPS SSH keys.
 *
 *   node scripts/panel-cli.js login <panel or launcher address> [--name <machine>]
 *   node scripts/panel-cli.js whoami
 *   node scripts/panel-cli.js nodes
 *   node scripts/panel-cli.js bots [text]
 *   node scripts/panel-cli.js get <path>                      GET /api/<path>, JSON out
 *   node scripts/panel-cli.js post|put|patch|delete <path> [json body]
 *   node scripts/panel-cli.js exec --node <name|id> [--timeout <s>] -- <command>
 *   node scripts/panel-cli.js exec --bot <name|id|pm2 name> [--timeout <s>] -- <command>
 *   node scripts/panel-cli.js logout                          forget the key on this machine
 *
 * login  makes a random key HERE and sends the panel only its sha256 and a
 *        name for this machine. The panel's bot posts Allow / Deny on Discord
 *        with a code, which this script prints too; Allow (7 / 30 / 90 days or
 *        no expiry) and the key is saved in ~/.bot-panel/cli.json
 *        (BOT_PANEL_CLI_CONFIG overrides) — outside every repo. The key is
 *        never printed.
 * exec   runs one command in a shell on a node (or in a project's folder on
 *        its node), through the panel's Terminal WebSocket and the node's
 *        agent, and exits with the command's exit code. The panel logs every
 *        command a key runs. Ctrl-C is sent when --timeout (default 300 s)
 *        runs out; the exit code is then 124.
 *
 * The address saved at login is resolved again on every run through
 * /api/health (redirects followed, no key sent), so a panel move to another
 * node's domain needs nothing here. Requests that carry the key never follow
 * a redirect.
 */

const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const WebSocket = require("ws");

const PREFIX = "bpc_";
const DEFAULT_TIMEOUT_S = 300;
const POLL_EVERY_MS = 3000;
const configPath = () => process.env.BOT_PANEL_CLI_CONFIG || path.join(os.homedir(), ".bot-panel", "cli.json");
const sha256 = (s) => crypto.createHash("sha256").update(String(s)).digest("hex");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const fail = (message) => Object.assign(new Error(message), { cli: true });

// ── Config ───────────────────────────────────────────────────────────────────

const readConfig = () => {
    let cfg;
    try {
        cfg = JSON.parse(fs.readFileSync(configPath(), "utf8"));
    } catch {
        throw fail(`No CLI key on this machine (${configPath()}) — run: node scripts/panel-cli.js login <panel address>`);
    }
    if (!cfg?.url || !String(cfg.key || "").startsWith(PREFIX)) throw fail(`${configPath()} is not a panel-cli config — run login again`);
    return cfg;
};

const writeConfig = (cfg) => {
    const file = configPath();
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    fs.writeFileSync(file, JSON.stringify(cfg, null, 2) + "\n", { mode: 0o600 });
    return file;
};

// ── Where the panel is ───────────────────────────────────────────────────────

const originOf = (addr) => {
    const s = String(addr || "").trim();
    if (!s) throw fail("Give the panel's address (its domain, or the launcher's)");
    try {
        return new URL(/^https?:\/\//i.test(s) ? s : `https://${s}`).origin;
    } catch {
        throw fail(`Not an address: ${s}`);
    }
};

/**
 * The origin of the panel that is active now, from any of its addresses (a
 * node's domain, the launcher). /api/health answers on every panel and says
 * where the panel is opened; a node that does not run it redirects there.
 */
const resolveBase = async (addr, depth = 0) => {
    if (depth > 4) throw fail(`Too many hops looking for the panel from ${addr}`);
    const start = originOf(addr);
    let res = null;
    let health = null;
    try {
        res = await fetch(`${start}/api/health`, { redirect: "follow", signal: AbortSignal.timeout(15_000) });
        health = await res.json().catch(() => null);
    } catch {
        /* the launcher may not serve /api/health — try its root below */
    }
    if (health && typeof health === "object" && "state" in health) {
        if (health.state === "fenced" && health.movedTo) return resolveBase(health.movedTo, depth + 1);
        return health.url ? originOf(health.url) : new URL(res.url).origin;
    }
    try {
        res = await fetch(start, { redirect: "follow", signal: AbortSignal.timeout(15_000) });
    } catch (err) {
        throw fail(`Cannot reach ${start}: ${err.cause?.message || err.message}`);
    }
    const landed = new URL(res.url).origin;
    if (landed !== start) return resolveBase(landed, depth + 1);
    throw fail(`No panel answers at ${start}`);
};

// ── HTTP ─────────────────────────────────────────────────────────────────────

const apiPath = (p) => `/api/${String(p || "").replace(/^\/+/, "").replace(/^api\//, "")}`;

/** One call to the panel's API; `key` null = no auth. Throws with the panel's own error text. */
const request = async (base, key, method, p, body) => {
    const headers = {};
    if (key) headers.Authorization = `Bearer ${key}`;
    if (body !== undefined) headers["Content-Type"] = "application/json";
    let res;
    try {
        res = await fetch(`${base}${apiPath(p)}`, {
            method,
            headers,
            body: body === undefined ? undefined : JSON.stringify(body),
            redirect: "manual", // the key never follows a redirect
            signal: AbortSignal.timeout(120_000),
        });
    } catch (err) {
        throw fail(`${method} ${apiPath(p)}: ${err.cause?.message || err.message}`);
    }
    if (res.status >= 300 && res.status < 400) throw fail(`${method} ${apiPath(p)}: the panel redirected (${res.status}) — it may have moved; run the command again`);
    const text = await res.text();
    let data = text;
    try { data = text ? JSON.parse(text) : null; } catch { /* not JSON */ }
    if (!res.ok) {
        const why = (data && typeof data === "object" && data.error) || String(text).slice(0, 300) || res.statusText;
        throw fail(`${method} ${apiPath(p)} → ${res.status}: ${why}`);
    }
    return data;
};

/** The saved key and the panel's address now. */
const session = async () => {
    const cfg = readConfig();
    return { cfg, base: await resolveBase(cfg.url), key: cfg.key };
};

// ── login / logout / whoami ──────────────────────────────────────────────────

const defaultName = () => {
    let user = "";
    try { user = os.userInfo().username; } catch { /* no user info */ }
    return `${os.hostname()}${user ? ` (${user})` : ""}`.slice(0, 80);
};

const login = async (addr, { name, log = console.log, pollMs = POLL_EVERY_MS } = {}) => {
    const base = await resolveBase(addr);
    const key = PREFIX + crypto.randomBytes(32).toString("base64url");
    const keyHash = sha256(key);
    const label = String(name || defaultName()).trim().slice(0, 80);
    const asked = await request(base, null, "POST", "cli-access/login", { name: label, keyHash });
    log(`Asked ${base} for a key for "${label}".`);
    log(`On Discord, check that the code is  ${asked.code}  and pick Allow (or Deny). Waiting up to 10 minutes…`);
    const deadline = (Number(asked.expiresAt) || Date.now() + 10 * 60_000) + 30_000;
    for (;;) {
        await sleep(pollMs);
        if (Date.now() > deadline) throw fail("Nobody answered in time — run login again.");
        let r;
        try {
            r = await request(base, null, "POST", "cli-access/login/poll", { id: asked.id, keyHash });
        } catch (err) {
            log(`(still waiting — ${err.message})`);
            continue;
        }
        if (r.status === "pending") continue;
        if (r.status === "denied") throw fail("Denied on Discord.");
        if (r.status !== "approved") throw fail("Nobody answered in time (or the panel restarted) — run login again.");
        const file = writeConfig({ url: originOf(addr), key, name: label, expiresAt: r.expiresAt ?? null, savedAt: Date.now() });
        log(`Allowed by ${r.decidedBy || "the owner"} — ${r.expiresAt ? `the key lasts until ${new Date(r.expiresAt).toLocaleString("en-GB")}` : "the key has no expiry"}.`);
        log(`Saved in ${file}.`);
        return { file, expiresAt: r.expiresAt ?? null };
    }
};

const logout = () => {
    const file = configPath();
    if (!fs.existsSync(file)) return console.log("No key saved on this machine.");
    fs.unlinkSync(file);
    console.log(`Removed ${file}. The key still works until it expires — revoke it on Panel Settings → Security.`);
};

// ── Lists ────────────────────────────────────────────────────────────────────

const table = (rows, cols) => {
    const width = cols.map((c) => Math.max(c.length, ...rows.map((r) => String(r[c] ?? "").length)));
    const line = (vals) => vals.map((v, i) => String(v ?? "").padEnd(width[i])).join("  ").trimEnd();
    return [line(cols), ...rows.map((r) => line(cols.map((c) => r[c])))].join("\n");
};

/** The one item of `list` that `wanted` names: exact on `_id`, then (case-insensitive) on `fields`. */
const pick = (list, wanted, fields, what) => {
    const w = String(wanted || "").trim();
    if (!w) throw fail(`Name the ${what}`);
    const byId = list.find((x) => x._id === w);
    if (byId) return byId;
    const hits = list.filter((x) => fields.some((f) => String(x[f] || "").toLowerCase() === w.toLowerCase()));
    if (hits.length === 1) return hits[0];
    if (hits.length > 1) throw fail(`"${w}" matches ${hits.length} ${what}s: ${hits.map((x) => `${x.name} (${x._id})`).join(", ")} — use the id`);
    throw fail(`No ${what} "${w}". Known: ${list.map((x) => x.name).join(", ") || "none"}`);
};

// ── exec ─────────────────────────────────────────────────────────────────────

// What a terminal adds that is not the command's output: colours and cursor
// moves, and the \r of every line end.
const plain = (s) =>
    String(s)
        // eslint-disable-next-line no-control-regex
        .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "")
        // eslint-disable-next-line no-control-regex
        .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
        // eslint-disable-next-line no-control-regex
        .replace(/\x1b[()][0-9A-Za-z]|\x1b[=>78DEHM]/g, "")
        .replace(/\r+\n/g, "\n")
        .replace(/\r/g, "\n");

/**
 * The command's output between the markers the panel's run line prints
 * (server/services/termService.js runLine). feed() takes terminal data and
 * returns the output it can already hand on; `done` is the exit code once the
 * END marker came. A tail is held back so a marker split over two frames is
 * never printed.
 */
const markerReader = (tag) => {
    const begin = `__PCLI_BEGIN_${tag}:`;
    const end = new RegExp(`\\n?__PCLI_END_${tag}:(\\d+)\\n`);
    const hold = begin.length + 16;
    let buf = "";
    let started = false;
    const r = {
        done: null,
        feed(data) {
            if (r.done != null) return "";
            buf += plain(data);
            if (!started) {
                const i = buf.indexOf(begin);
                if (i < 0) {
                    buf = buf.slice(-hold);
                    return "";
                }
                buf = buf.slice(i + begin.length).replace(/^\n/, "");
                started = true;
            }
            const m = end.exec(buf);
            if (m) {
                r.done = Number(m[1]);
                const out = buf.slice(0, m.index);
                buf = "";
                return out;
            }
            if (buf.length <= hold) return "";
            const out = buf.slice(0, buf.length - hold);
            buf = buf.slice(-hold);
            return out;
        },
        /** What is left when the shell ended without the END marker. */
        rest() {
            const out = started ? buf : "";
            buf = "";
            return out;
        },
    };
    return r;
};

/**
 * Run `command` on a node (`node`) or in a project's folder (`bot`). Output
 * goes to `out` as it comes. → the exit code (124 on timeout).
 */
const exec = async ({ base, key, node, bot, command, timeoutS = DEFAULT_TIMEOUT_S, out = process.stdout, err = process.stderr }) => {
    if (!String(command || "").trim()) throw fail("Give a command to run (after --)");
    if (!node === !bot) throw fail("Say where: --node <name|id> or --bot <name|id|pm2 name>");
    const query = bot
        ? `bot=${encodeURIComponent(pick(await request(base, key, "GET", "bots"), bot, ["name", "pm2Name", "botID"], "project")._id)}`
        : `node=${encodeURIComponent(pick(await request(base, key, "GET", "nodes"), node, ["name"], "node")._id)}`;
    const tag = crypto.randomBytes(8).toString("hex");
    const reader = markerReader(tag);

    return new Promise((resolve, reject) => {
        const ws = new WebSocket(`${base.replace(/^http/, "ws")}/api/term?${query}`, { headers: { Authorization: `Bearer ${key}` } });
        let settled = false;
        let sent = false;
        const finish = (code, error) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            clearTimeout(firstWait);
            try { ws.close(); } catch { /* closing */ }
            if (error) reject(error);
            else resolve(code);
        };
        const run = () => {
            if (sent || ws.readyState !== WebSocket.OPEN) return;
            sent = true;
            ws.send(JSON.stringify({ type: "run", command, tag }));
        };
        // The shell's first output (its prompt) says it is ready for input;
        // a quiet shell gets the command after 2 s anyway.
        let firstWait = null;
        const timer = setTimeout(() => {
            err.write(`\n[panel-cli] timed out after ${timeoutS} s — sent Ctrl-C\n`);
            try { ws.send(JSON.stringify({ type: "input", data: "\x03" })); } catch { /* closed */ }
            setTimeout(() => finish(124), 1000);
        }, timeoutS * 1000);

        ws.on("unexpected-response", (req, res) => {
            const why = res.statusCode === 401 ? "the panel refused the key (revoked or expired?) — run login again" : `HTTP ${res.statusCode}`;
            finish(null, fail(`Cannot open a shell: ${why}`));
        });
        ws.on("open", () => {
            ws.send(JSON.stringify({ type: "resize", cols: 200, rows: 50 }));
            firstWait = setTimeout(run, 2000);
        });
        ws.on("message", (raw) => {
            let msg;
            try { msg = JSON.parse(raw.toString()); } catch { return; }
            if (msg.type === "data") {
                if (!sent) {
                    // The panel's own notes ("[panel] Cannot reach node …") come before any prompt.
                    const note = plain(msg.data).match(/\[(?:panel|agent)\][^\n]*/g);
                    if (note) err.write(`${note.join("\n")}\n`);
                    run();
                    return;
                }
                const text = reader.feed(msg.data);
                if (text) out.write(text);
                if (reader.done != null) finish(reader.done);
            } else if (msg.type === "exit") {
                const rest = reader.rest();
                if (rest) out.write(rest);
                finish(reader.done ?? (Number.isInteger(msg.code) ? msg.code : 1));
            }
        });
        ws.on("close", () => {
            if (settled) return;
            const rest = reader.rest();
            if (rest) out.write(rest);
            finish(null, fail("The shell closed before the command finished"));
        });
        ws.on("error", (e) => finish(null, fail(`Shell connection failed: ${e.message}`)));
    });
};

// ── Command line ─────────────────────────────────────────────────────────────

const parseArgs = (argv) => {
    const dash = argv.indexOf("--");
    const head = dash >= 0 ? argv.slice(0, dash) : argv;
    const tail = dash >= 0 ? argv.slice(dash + 1) : null;
    const flags = {};
    const pos = [];
    for (let i = 0; i < head.length; i++) {
        const a = head[i];
        if (a.startsWith("--")) {
            const [k, v] = a.slice(2).split(/=(.*)/s);
            flags[k] = v !== undefined ? v : head[i + 1] && !head[i + 1].startsWith("--") ? head[++i] : true;
        } else pos.push(a);
    }
    return { cmd: pos[0], pos: pos.slice(1), flags, tail };
};

const USAGE = `panel-cli — the owner's access to the panel with a CLI access key

  node scripts/panel-cli.js login <panel or launcher address> [--name <machine>]
  node scripts/panel-cli.js whoami
  node scripts/panel-cli.js nodes
  node scripts/panel-cli.js bots [text]
  node scripts/panel-cli.js get <path>                      GET /api/<path>, JSON out
  node scripts/panel-cli.js post|put|patch|delete <path> [json body]
  node scripts/panel-cli.js exec --node <name|id> [--timeout <s>] -- <command>
  node scripts/panel-cli.js exec --bot <name|id|pm2 name> [--timeout <s>] -- <command>
  node scripts/panel-cli.js logout                          forget the key on this machine

The key is kept in ${configPath()}.`;

const main = async () => {
    const { cmd, pos, flags, tail } = parseArgs(process.argv.slice(2));
    const show = (data) => console.log(typeof data === "string" ? data : JSON.stringify(data, null, 2));

    switch (cmd) {
        case "login":
            await login(pos[0] || flags.url, { name: typeof flags.name === "string" ? flags.name : undefined });
            return 0;
        case "logout":
            logout();
            return 0;
        case "whoami": {
            const { base, key } = await session();
            const me = await request(base, key, "GET", "auth/verify");
            const exp = me.cli?.expiresAt ? `until ${new Date(me.cli.expiresAt).toLocaleString("en-GB")}` : "no expiry";
            console.log(`${base} · ${me.kind}${me.cli ? ` through CLI key "${me.cli.name}" (${exp})` : ""}`);
            return 0;
        }
        case "nodes": {
            const { base, key } = await session();
            const nodes = await request(base, key, "GET", "nodes");
            console.log(table(nodes.map((n) => ({ name: n.name, id: n._id, status: n.status, panel: n.isPanelNode ? "yes" : "", projects: n.botCount })), ["name", "id", "status", "panel", "projects"]));
            return 0;
        }
        case "bots": {
            const { base, key } = await session();
            const want = String(pos[0] || "").toLowerCase();
            const bots = (await request(base, key, "GET", "bots")).filter((b) => !want || [b.name, b.pm2Name, b._id, b.nodeName].some((v) => String(v || "").toLowerCase().includes(want)));
            console.log(table(bots.map((b) => ({ name: b.name, id: b._id, pm2: b.pm2Name, node: b.nodeName, status: b.live?.status || "—" })), ["name", "id", "pm2", "node", "status"]));
            return 0;
        }
        case "get":
        case "post":
        case "put":
        case "patch":
        case "delete": {
            if (!pos[0]) throw fail(`${cmd} needs a path, e.g. ${cmd} /nodes`);
            let body;
            if (cmd !== "get" && pos[1] !== undefined) {
                try { body = JSON.parse(pos[1]); } catch { throw fail("The body must be JSON"); }
            }
            const { base, key } = await session();
            show(await request(base, key, cmd.toUpperCase(), pos[0], body));
            return 0;
        }
        case "exec": {
            const command = (tail || pos).join(" ");
            const { base, key } = await session();
            const timeoutS = Number(flags.timeout) > 0 ? Number(flags.timeout) : DEFAULT_TIMEOUT_S;
            return exec({ base, key, node: flags.node === true ? "" : flags.node, bot: flags.bot === true ? "" : flags.bot, command, timeoutS });
        }
        default:
            console.log(USAGE);
            return cmd && cmd !== "help" ? 1 : 0;
    }
};

if (require.main === module) {
    main().then(
        (code) => process.exit(code ?? 0),
        (err) => {
            console.error(`panel-cli: ${err.cli ? err.message : err.stack || err.message}`);
            process.exit(1);
        },
    );
}

module.exports = { resolveBase, request, login, exec, markerReader, plain, pick, parseArgs, configPath, PREFIX };
