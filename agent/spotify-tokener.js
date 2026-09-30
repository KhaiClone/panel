#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────────
//  spotify-tokener — a Node port of github.com/topi314/spotify-tokener
//
//  LavaSrc (the Lavalink plugin behind Spotify links) loads playlists and
//  searches through Spotify's partner API, and that takes the web player's
//  anonymous token. Spotify guards /api/token with a TOTP whose secret rotates
//  inside its JS bundle, so instead of chasing that secret this does what the
//  upstream Go service does: load open.spotify.com in a headless Chrome and hand
//  back the /api/token response the page fetched for itself.
//
//  The agent runs one next to Lavalink (pm2 "spotify-tokener") whenever
//  application.yml points LavaSrc's `customTokenEndpoint` at this machine —
//  see services/spotifyTokener.js.
//
//  node spotify-tokener.js --addr 127.0.0.1:8081 --chrome /usr/bin/google-chrome [--profile DIR]
//
//  GET /api/token  Spotify's token JSON, exactly as the web player received it.
//                  Cookies sent with the request (sp_dc, for an account token)
//                  are set in a private browser context, so they never leak
//                  into the anonymous tokens.
//  GET /health     { ok, browser, lastTokenAt, lastError } — no Chrome work.
// ─────────────────────────────────────────────────────────────────────────────

const http = require("http");
const path = require("path");
const puppeteer = require("puppeteer-core");

const arg = (name, fallback = null) => {
    const i = process.argv.indexOf(`--${name}`);
    return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
};

const ADDR = arg("addr", "127.0.0.1:8081");
const CHROME = arg("chrome", process.env.SPOTIFY_TOKENER_CHROME_PATH || null);
// In the working directory rather than /tmp: snap's Chromium gets a private
// /tmp and cannot open a profile the caller created there.
const PROFILE = arg("profile", path.join(process.cwd(), "chrome-profile"));
const TIMEOUT_MS = 30_000;

const SPOTIFY_URL = "https://open.spotify.com";
const TOKEN_URL = `${SPOTIFY_URL}/api/token`;
// The user agent upstream uses.
const USER_AGENT =
    "Mozilla/5.0 (Linux; Android 6.0; Nexus 5 Build/MRA58N) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Mobile Safari/537.36";

if (!CHROME) {
    console.error("[tokener] No Chrome — pass --chrome <path> or set SPOTIFY_TOKENER_CHROME_PATH");
    process.exit(1);
}
const sep = ADDR.lastIndexOf(":");
const HOST = ADDR.slice(0, sep) || "127.0.0.1";
const PORT = parseInt(ADDR.slice(sep + 1), 10);
if (!Number.isInteger(PORT) || PORT < 1 || PORT > 65535) {
    console.error(`[tokener] Invalid --addr "${ADDR}" — expected host:port`);
    process.exit(1);
}

let lastTokenAt = null;
let lastError = null;

// ── Browser ──────────────────────────────────────────────────────────────────
// One Chrome for the life of the process, relaunched after a crash. Chrome
// refuses to start its sandbox as root, as chromedp (upstream) also knows.
let noSandbox = typeof process.getuid === "function" && process.getuid() === 0;
let browserPromise = null;

const launch = () =>
    puppeteer.launch({
        executablePath: CHROME,
        headless: true,
        userDataDir: PROFILE,
        args: [
            "--disable-gpu",
            "--disable-dev-shm-usage",
            "--mute-audio",
            "--no-first-run",
            "--no-default-browser-check",
            "--disk-cache-size=52428800",
            ...(noSandbox ? ["--no-sandbox"] : []),
        ],
    });

const getBrowser = () => {
    if (!browserPromise) {
        browserPromise = (async () => {
            let browser;
            try {
                browser = await launch();
            } catch (err) {
                // Ubuntu 23.10+ blocks the unprivileged user namespaces Chrome's
                // sandbox is built on unless Chrome ships an AppArmor profile or a
                // setuid helper — snap and some distro builds do not.
                if (noSandbox || !/sandbox/i.test(err.message)) throw err;
                console.warn("[tokener] Chrome's sandbox is unavailable on this machine — running without it");
                noSandbox = true;
                browser = await launch();
            }
            browser.on("disconnected", () => {
                browserPromise = null;
            });
            console.log(`[tokener] Chrome ${await browser.version()} started`);
            return browser;
        })().catch((err) => {
            browserPromise = null;
            throw err;
        });
    }
    return browserPromise;
};

// ── Token ────────────────────────────────────────────────────────────────────

const parseCookies = (header = "") =>
    header
        .split(";")
        .map((part) => {
            const i = part.indexOf("=");
            return i > 0 ? { name: part.slice(0, i).trim(), value: part.slice(i + 1).trim() } : null;
        })
        .filter((c) => c && c.name);

const fetchToken = async (cookies) => {
    const browser = await getBrowser();
    // Anonymous requests share the default context and its warm cache; a request
    // carrying an account cookie gets a context of its own, thrown away after.
    const context = cookies.length ? await browser.createBrowserContext() : browser.defaultBrowserContext();
    const page = await context.newPage();
    try {
        if (cookies.length) {
            await context.setCookie(
                ...cookies.map((c) => ({ ...c, domain: ".spotify.com", path: "/", secure: true })),
            );
        }
        await page.setUserAgent(USER_AGENT);
        const tokenResponse = page.waitForResponse((r) => r.url().startsWith(TOKEN_URL), { timeout: TIMEOUT_MS });
        const navigation = page.goto(SPOTIFY_URL, { waitUntil: "domcontentloaded", timeout: TIMEOUT_MS });
        // The page's own scripts fetch the token, usually before the load event.
        // A failed navigation (no network, DNS) wins the race with its real error
        // instead of surfacing 30 seconds later as a bare timeout.
        const res = await Promise.race([tokenResponse, navigation.then(() => tokenResponse)]);
        return { status: res.status(), body: await res.text() };
    } finally {
        await page.close().catch(() => {});
        if (cookies.length) await context.close().catch(() => {});
    }
};

// Lavalink asking twice at once gets one page load between them.
let anonymousInFlight = null;
const getToken = (cookies) => {
    if (cookies.length) return fetchToken(cookies);
    if (!anonymousInFlight) {
        anonymousInFlight = fetchToken([]).finally(() => {
            anonymousInFlight = null;
        });
    }
    return anonymousInFlight;
};

// ── HTTP ─────────────────────────────────────────────────────────────────────

const json = (res, status, body) => {
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(typeof body === "string" ? body : JSON.stringify(body));
};

const server = http.createServer(async (req, res) => {
    const { pathname } = new URL(req.url, "http://tokener");
    if (req.method !== "GET") return json(res, 405, { error: "GET only" });

    if (pathname === "/health") {
        return json(res, 200, { ok: true, browser: Boolean(browserPromise), lastTokenAt, lastError });
    }
    if (pathname !== "/api/token") return json(res, 404, { error: "Not found" });

    try {
        const { status, body } = await getToken(parseCookies(req.headers.cookie));
        if (status === 200) {
            lastTokenAt = Date.now();
            lastError = null;
            return json(res, 200, body);
        }
        lastError = `Spotify answered /api/token with HTTP ${status}`;
        console.error(`[tokener] ${lastError}`);
        json(res, 502, body || { error: lastError });
    } catch (err) {
        lastError = err.message.split("\n")[0];
        console.error(`[tokener] ${lastError}`);
        json(res, 500, { error: lastError });
    }
});

server.listen(PORT, HOST, () => {
    console.log(`[tokener] Listening on ${HOST}:${PORT} (Chrome: ${CHROME})`);
    // Warm up like upstream does: Chrome's first start and first page load are
    // the slow part, and LavaSrc should not be the one waiting on them.
    getToken([])
        .then(() => {
            lastTokenAt = Date.now();
            console.log("[tokener] First token fetched — ready");
        })
        .catch((err) => {
            lastError = err.message.split("\n")[0];
            console.error(`[tokener] Warm-up failed: ${lastError}`);
        });
});
