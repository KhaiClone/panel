const fs = require("fs");
const net = require("net");
const path = require("path");
const http = require("http");
const { exec } = require("child_process");
const util = require("util");
const execAsync = util.promisify(exec);

const pm2 = require("./pm2");
const { LAVALINK_DIR } = require("./lavalink");

// ─────────────────────────────────────────────────────────────────────────────
//  spotify-tokener — Spotify's anonymous token for LavaSrc, next to Lavalink.
//
//  LavaSrc loads Spotify playlists and searches through the partner API, which
//  takes the web player's anonymous token, and Spotify only hands that to a
//  real browser. So application.yml points LavaSrc's `customTokenEndpoint` at a
//  small service driving headless Chrome (../spotify-tokener.js). A node
//  without one fails every Spotify link while YouTube keeps working — which is
//  how nodes ran without it unnoticed.
//
//  It follows Lavalink: it runs while Lavalink runs AND the config points
//  customTokenEndpoint at this machine. The panel reads that port out of the
//  shared application.yml — so every node runs the same tokener on the same
//  port — and passes it as `tokenerPort` on every call (null: not wanted here;
//  absent: a panel from before this, leave it alone). Like Java, Chrome is never
//  installed from here — a missing one is reported and the page shows the command.
//
//  A tokener the panel did not start is never touched. Something already
//  answering on the port (the Go original, a container) or a pm2 process by
//  this name from somewhere else means the node has one: the panel reports it
//  and starts nothing next to it. Only the process pm2.startBot registered from
//  DIR is the panel's to start, stop and remove.
// ─────────────────────────────────────────────────────────────────────────────

const PM2_NAME = process.env.SPOTIFY_TOKENER_PM2_NAME || "spotify-tokener";
// A directory of its own: pm2.startBot writes its wrapper script into the cwd,
// and Lavalink's already lives in LAVALINK_DIR. That wrapper is also how the
// panel's own process is told apart from anybody else's.
const DIR = path.join(LAVALINK_DIR, "spotify-tokener");
const WRAPPER = path.join(DIR, ".noflex-start.sh");
const SCRIPT = path.resolve(__dirname, "../spotify-tokener.js");
const STATE = () => path.join(DIR, "state.json");

// /snap/bin is spelled out: a PM2 started from systemd often has no snap PATH.
const CHROME_CANDIDATES = [
    "google-chrome-stable",
    "google-chrome",
    "chromium",
    "chromium-browser",
    "/snap/bin/chromium",
    "chrome-headless-shell",
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * The Chrome this node would use. Asked for its version rather than trusted to
 * exist: Ubuntu's chromium-browser is a stub that exits non-zero when the snap
 * it points to is missing.
 */
const chromeInfo = async () => {
    const override = process.env.SPOTIFY_TOKENER_CHROME_PATH;
    for (const name of override ? [override] : CHROME_CANDIDATES) {
        try {
            const bin = name.includes("/") ? name : (await execAsync(`command -v "${name}"`, { timeout: 5000 })).stdout.trim();
            if (!bin) continue;
            const { stdout } = await execAsync(`"${bin}" --version`, { timeout: 15_000 });
            return { present: true, path: bin, version: stdout.trim() };
        } catch { /* next candidate */ }
    }
    return { present: false, path: null, version: null };
};

const readState = () => {
    try {
        return JSON.parse(fs.readFileSync(STATE(), "utf8"));
    } catch {
        return {};
    }
};

/** The pm2 process by this name, whoever started it. */
const findProc = async () => (await pm2.getProcessList()).find((p) => p.name === PM2_NAME) || null;

/** True only for the process pm2.startBot registered from DIR. */
const isOurs = (proc) =>
    Boolean(proc) && (proc.pm2_env?.pm_exec_path === WRAPPER || proc.pm2_env?.pm_cwd === DIR);

const isUp = (proc) => ["online", "launching"].includes(proc?.pm2_env?.status);

/** Whether anything accepts a connection on 127.0.0.1:port. */
const portOpen = (port, timeout = 1500) =>
    new Promise((resolve) => {
        const sock = net.connect({ host: "127.0.0.1", port });
        const done = (open) => {
            sock.destroy();
            resolve(open);
        };
        sock.setTimeout(timeout, () => done(false));
        sock.once("connect", () => done(true));
        sock.once("error", () => done(false));
    });

/** GET 127.0.0.1:<port><path>. Resolves {status, body} — status 0 when nothing answered. */
const get = (port, urlPath, timeout) =>
    new Promise((resolve) => {
        const req = http.get({ host: "127.0.0.1", port, path: urlPath, timeout }, (res) => {
            let body = "";
            res.on("data", (c) => (body += c));
            res.on("end", () => resolve({ status: res.statusCode, body }));
        });
        req.on("timeout", () => req.destroy(new Error("timeout")));
        req.on("error", (err) => resolve({ status: 0, body: "", error: err.code || err.message }));
    });

const removeOurs = async () => {
    await pm2.deleteBot(PM2_NAME);
    fs.rmSync(STATE(), { force: true });
};

// ─────────────────────────────────────────────────────────────────────────────

/**
 * What the page shows. `wantedPort` is the port the config sends LavaSrc to,
 * so a tokener the panel did not start can be recognised there.
 *
 * `managed`: the panel's own process exists. `external`: something else answers
 * on the port. `foreignPm2`: a pm2 process by this name that the panel did not
 * start. Never fetches a token, so the page can poll it as often as it likes.
 */
const status = async (wantedPort = null) => {
    const [chrome, proc] = await Promise.all([chromeInfo(), findProc()]);
    const managed = isOurs(proc);
    const live = await pm2.getBotStatus(PM2_NAME, managed ? [proc] : []);
    const statePort = managed ? readState().port ?? null : null;

    let health = null;
    let external = false;
    if (managed && live.status === "online" && statePort) {
        const r = await get(statePort, "/health", 3000);
        try {
            health = r.status === 200 ? JSON.parse(r.body) : { ok: false, lastError: r.error || `HTTP ${r.status}` };
        } catch {
            health = { ok: false, lastError: "unreadable /health answer" };
        }
    } else if (wantedPort && (await portOpen(wantedPort))) {
        external = true;
    }

    return {
        pm2Name: PM2_NAME,
        port: statePort ?? wantedPort ?? null,
        arch: process.arch,
        chrome,
        managed,
        external,
        foreignPm2: Boolean(proc) && !managed,
        live,
        health,
    };
};

/**
 * Make the tokener match what the config asks for.
 *
 * Never fails over a missing Chrome — only Spotify depends on the tokener, so
 * it must not stop Lavalink from starting. That comes back as `error` instead.
 * `force` restarts the panel's own one (the Restart button: Chrome can wedge).
 */
const ensure = async (port, { force = false } = {}) => {
    const proc = await findProc();
    const managed = isOurs(proc);

    if (!port) {
        if (managed) await removeOurs();
        return { wanted: false, running: false };
    }
    const n = Number(port);
    if (!Number.isInteger(n) || n < 1 || n > 65535) throw new Error(`Invalid tokener port "${port}"`);

    // A tokener the panel did not start: report it, start nothing next to it.
    if (proc && !managed) {
        return {
            wanted: true,
            port: n,
            external: true,
            running: await portOpen(n),
            note: `pm2 process "${PM2_NAME}" was not started by the panel — left alone`,
        };
    }
    const state = managed ? readState() : {};
    const oursHoldsPort = managed && isUp(proc) && state.port === n;
    if (!oursHoldsPort && (await portOpen(n))) {
        // The panel's own one, parked on another port or crash-looping on this
        // one, is redundant next to a tokener that already answers.
        if (managed) await removeOurs();
        return { wanted: true, port: n, external: true, running: true, note: `a tokener the panel did not start already answers on 127.0.0.1:${n} — left alone` };
    }

    const chrome = await chromeInfo();
    if (!chrome.present) {
        return {
            wanted: true,
            port: n,
            running: false,
            code: "chrome-missing",
            error: "Chrome is not installed on this node — Spotify links need it for spotify-tokener",
        };
    }

    if (!force && oursHoldsPort && proc.pm2_env.status === "online" && state.chrome === chrome.path) {
        return { wanted: true, port: n, running: true, started: false };
    }

    fs.mkdirSync(DIR, { recursive: true });
    const cmd = `node "${SCRIPT}" --addr 127.0.0.1:${n} --chrome "${chrome.path}" --profile "${path.join(DIR, "chrome-profile")}"`;
    // An explicit ceiling, for the reason spelled out on lavalink.start(). This
    // counts Node only: Chrome's own processes are children pm2 does not sum.
    await pm2.startBot(PM2_NAME, DIR, cmd, "300M", null);
    fs.writeFileSync(STATE(), `${JSON.stringify({ port: n, chrome: chrome.path })}\n`);
    return { wanted: true, port: n, running: true, started: true };
};

/**
 * Ask for a real token, the way LavaSrc will. pm2 "online" only says Node
 * started; Chrome can still fail to launch and Spotify can still refuse, so
 * this is the only check that means anything — for a tokener the panel did not
 * start, too: it answers on the same port, so it gets the same question.
 *
 * 30s: a cold Chrome answers in a few seconds, and a sync's whole agent call —
 * Lavalink's 60s health wait included — has to fit in the panel's 120s.
 */
const verify = async (port, timeoutMs = 30_000) => {
    const deadline = Date.now() + timeoutMs;
    let last = "no answer";
    while (Date.now() < deadline) {
        const r = await get(port, "/api/token", Math.max(5000, deadline - Date.now()));
        if (r.status === 200) {
            try {
                if (JSON.parse(r.body).accessToken) return { ok: true };
            } catch { /* falls through */ }
            last = "answered without an accessToken";
        } else if (r.status) {
            let detail = r.body.slice(0, 160);
            try {
                detail = JSON.parse(r.body).error || detail;
            } catch { /* keep the raw text */ }
            last = `HTTP ${r.status}${detail ? `: ${detail}` : ""}`;
        } else {
            last = r.error;
        }
        // Only "nothing listening yet" is worth waiting out; an answer is final.
        if (r.error !== "ECONNREFUSED") break;
        await sleep(1000);
    }
    return { ok: false, error: last };
};

/** Stops the panel's own tokener; one it did not start keeps running. */
const stop = async () => {
    if (isOurs(await findProc())) await pm2.stopBot(PM2_NAME);
};

/** Its pm2 log, or null when there is no process by that name. */
const logs = async (lines = 100) => ((await findProc()) ? pm2.getBotLogs(PM2_NAME, lines) : null);

module.exports = { PM2_NAME, DIR, chromeInfo, status, ensure, verify, stop, logs };
