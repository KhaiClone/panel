// A backup waiting in restore/ (dropped there by hand, or staged by Panel
// Settings → Backup & Rollback) replaces the data and .env BEFORE anything
// reads them — so this must stay ahead of dotenv. See services/backupArchive.js.
require("./services/backupArchive").restore();
require("dotenv").config();
const express = require("express");
const cors = require("cors");
const helmet = require("helmet");
const path = require("path");

const authRoutes = require("./routes/auth");
const botRoutes = require("./routes/bots");
const logRoutes = require("./routes/logs");
const systemRoutes = require("./routes/system");
const groupRoutes = require("./routes/groups");
const bulkRoutes = require("./routes/bulk");
const externalRoutes = require("./routes/external");
const panelRoutes = require("./routes/panel");
const githubRoutes = require("./routes/github");
const proxyRoutes = require("./routes/proxy");
const proxiesRoutes = require("./routes/proxies");
const tagRoutes = require("./routes/tags");
const notificationRoutes = require("./routes/notifications");
const nodeRoutes = require("./routes/nodes");
const shopOrderRoutes = require("./routes/shopOrders");
const decorRoutes = require("./routes/decors");
const questRoutes = require("./routes/quests");
const questExternalRoutes = require("./routes/questsExternal");
const pricingRoutes = require("./routes/pricing");
const pricingExternalRoutes = require("./routes/pricingExternal");
const badgeRoutes = require("./routes/badges");
const badgeExternalRoutes = require("./routes/badgesExternal");
const lavalinkRoutes = require("./routes/lavalink");
const { authMiddleware } = require("./middleware/auth");
const { apiKeyMiddleware } = require("./middleware/apiKey");
const nodeContext = require("./middleware/nodeContext");
const errorHandler = require("./middleware/errorHandler");
const lifecycleGate = require("./middleware/lifecycleGate");
const lifecycle = require("./services/lifecycle");
const panelLease = require("./services/panelLease");
const panelMigration = require("./services/panelMigration");
const expiryService = require("./services/expiryService");
const backupService = require("./services/backupService");
const memoryMonitorService = require("./services/memoryMonitorService");
const nodeService = require("./services/nodeService");
const termService = require("./services/termService");
const samplerService = require("./services/samplerService");
const proxyStore = require("./services/proxyStore");
const questService = require("./services/questService");
const questMonthly = require("./services/questMonthly");
const badgeService = require("./services/badgeService");
const lavalinkUpdater = require("./services/lavalinkUpdater");

// ─────────────────────────────────────────────────────────────────────────────
//  Validate critical env vars on startup
// ─────────────────────────────────────────────────────────────────────────────
// The panel is single-account: ADMIN_USERNAME + ADMIN_PASSWORD_HASH ARE the
// account. There is no users table and no roles — routes/auth.js checks the env
// directly, and any valid token is full access.
//
// NOTE: bots with no nodeId (or the legacy "local") are resolved at read time by
// nodeService.resolveNodeId → PANEL_NODE_ID, never rewritten in the DB.
// (BOTS_ROOT_DIR / SITES_ROOT_DIR belong to each node's agent, not to the panel.)
const required = [
    "ADMIN_USERNAME",
    "ADMIN_PASSWORD_HASH",
    "JWT_SECRET",
];
for (const key of required) {
    if (!process.env[key]) {
        console.error(`[Server] Missing required env var: ${key}`);
        process.exit(1);
    }
}

// ─────────────────────────────────────────────────────────────────────────────
//  App Setup
// ─────────────────────────────────────────────────────────────────────────────
const app = express();

// Security headers — disable CSP so React app can load from same origin
app.use(helmet({ contentSecurityPolicy: false }));

// CORS — in dev, allow Vite dev server; in prod, same origin only
app.use(
    cors({
        origin:
            process.env.NODE_ENV === "production"
                ? false
                : process.env.CLIENT_URL || "http://localhost:5173",
        credentials: true,
    }),
);

// env files could be a bit large. Shared data brings its own, larger parser.
const jsonBody = express.json({ limit: "2mb" });
app.use((req, res, next) => (req.path.startsWith("/api/external/data") ? next() : jsonBody(req, res, next)));

// ─────────────────────────────────────────────────────────────────────────────
//  API Routes
// ─────────────────────────────────────────────────────────────────────────────
// Public liveness probe. A panel move polls it through the target's agent and
// waits for state "active" at the new epoch; nothing sensitive in it.
// `url` is where people open this panel — the launcher on Vercel asks every
// panel domain and sends the browser to the active one with the highest epoch.
app.get("/api/health", async (req, res) => {
    const { state, info } = lifecycle.get();
    // A replaced panel says where the panel went (its public address, not a secret).
    const movedTo = state === "fenced" ? info?.url || null : undefined;
    const url = state === "fenced" ? undefined : await require("./services/panelDomains").currentUrl().catch(() => null);
    // Readable from any origin: a tab left on an old panel address reaches this
    // through a cross-origin redirect and learns where the panel is now.
    res.set("Access-Control-Allow-Origin", "*");
    res.json({ ok: state === "active", state, epoch: panelLease.current(), url, movedTo });
});
// Starting / moving / replaced: refuse writes (see middleware/lifecycleGate.js).
app.use("/api", lifecycleGate);
app.use("/api/auth", authRoutes);
app.use("/api/bots", authMiddleware, nodeContext, botRoutes);
app.use("/api/groups", authMiddleware, groupRoutes);
app.use("/api/bulk", authMiddleware, bulkRoutes);
app.use("/api/logs", logRoutes); // Auth handled per-route (SSE needs query-param token)
app.use("/api/system", authMiddleware, nodeContext, systemRoutes);
app.use("/api/panel", authMiddleware, panelRoutes);
app.use("/api/github", authMiddleware, githubRoutes);
app.use("/api/proxy", authMiddleware, proxyRoutes);
// /api/proxy pins a bot's IP to a VPS; /api/proxies is the panel's own egress pool.
app.use("/api/proxies", authMiddleware, proxiesRoutes);
app.use("/api/external/data", apiKeyMiddleware, require("./routes/dataExternal"));
app.use("/api/external/quests", apiKeyMiddleware, questExternalRoutes);
app.use("/api/external/pricing", apiKeyMiddleware, pricingExternalRoutes);
app.use("/api/external/badges", apiKeyMiddleware, badgeExternalRoutes);
// ArnTo-Auto's Deco Gift panel: catalog, and shop orders over the bus (services/decorGiftService.js).
app.use("/api/external/decor-gift", apiKeyMiddleware, require("./routes/decorGiftExternal"));
app.use("/api/external", apiKeyMiddleware, externalRoutes);
app.use("/api/tags", authMiddleware, tagRoutes);
app.use("/api/notifications", authMiddleware, notificationRoutes);
app.use("/api/nodes", authMiddleware, nodeRoutes);
// Public: a new VPS joining with the one-command setup (token-guarded, see routes/join.js).
app.use("/api/join", require("./routes/join"));
app.use("/api/shop", authMiddleware, shopOrderRoutes);
app.use("/api/decors", authMiddleware, decorRoutes);
// Public, read-only: the decor site's live data (routes/decorsPublic.js).
app.use("/api/public/decors", require("./routes/decorsPublic"));
app.use("/api/quests", authMiddleware, questRoutes);
app.use("/api/pricing", authMiddleware, pricingRoutes);
app.use("/api/badges", authMiddleware, badgeRoutes);
app.use("/api/lavalink", authMiddleware, lavalinkRoutes);

// ─────────────────────────────────────────────────────────────────────────────
//  Serve React Build in Production
// ─────────────────────────────────────────────────────────────────────────────
if (process.env.NODE_ENV === "production") {
    const distPath = path.join(__dirname, "../client/dist");
    app.use(express.static(distPath));
    // SPA fallback — all non-API routes serve index.html
    app.get("*", (req, res) => {
        res.sendFile(path.join(distPath, "index.html"));
    });
}

// ─────────────────────────────────────────────────────────────────────────────
//  Global Error Handler — must be last
// ─────────────────────────────────────────────────────────────────────────────
app.use(errorHandler);

// ─────────────────────────────────────────────────────────────────────────────
//  Scheduled Services
// ─────────────────────────────────────────────────────────────────────────────
// Every scheduled callback is wrapped in lifecycle.guard(), so these keep their
// timers but do nothing while the panel is not active (moving, or replaced).
const startBackgroundServices = () => {
    expiryService.start();
    backupService.start();
    memoryMonitorService.start();
    nodeService.startHealthPolling();
    samplerService.start();
    // Rotates registered rotating proxies while they are idle; never mid-run.
    proxyStore.startRotationScheduler();
    // Daily Lavalink release check (02:00 in the timezone stored in the settings).
    lavalinkUpdater.start().catch((e) => console.error("[Lavalink] Scheduler start failed:", e.message));
    // Resume any quest accounts that were running before a restart (or a move).
    questService.restore().catch((e) => console.warn("[Quest] restore error:", e.message));
    // Erase single-quest accounts older than the retention window (1 week), hourly.
    questService.startRetentionSweep();
    // Monthly subscription schedulers (Tue/Sat run + daily enroll scan).
    questMonthly.start();
    // Auto Badge: resume interrupted orders + the ~26h verification sweep.
    badgeService.start();
    // Re-claim every agent: one that was down at boot, or restarted since, learns
    // where its panel gateway should forward — and a newer panel fences this one.
    setInterval(lifecycle.guard(() => panelLease.claimAll().catch(() => {})), 5 * 60 * 1000);
    // Commands to the bots go through Discord, never over the network.
    require("./services/discordBus").start().catch((e) => console.error("[Bus] start failed:", e.message));
    // The public decor site's data snapshot follows the shared decor data.
    require("./services/decorSitePublisher").start();
};

/**
 * Nothing runs until this panel knows it is the one in charge:
 *   1. load its epoch; on the first boot after a move, adopt the new one and
 *      fix the node records (panelMigration.finalizeIncoming)
 *   2. claim every agent at that epoch — an agent that already follows a
 *      newer panel fences this one, and then nothing below starts
 *   3. start the background services
 */
const bootstrap = async () => {
    await panelLease.load();
    let incoming = null;
    try {
        incoming = await panelMigration.finalizeIncoming();
    } catch (err) {
        console.error("[Move] Could not finish taking over:", err.message);
    }
    // Callbacks registered before per-project keys get their owner written down,
    // so they reach their project on the Discord bus without any address.
    await require("./services/callbackService").stampOwners().catch((err) =>
        console.error("[Panel] Could not record callback owners:", err.message),
    );
    // Panel domains from before they belonged to a node: they point at this one.
    await require("./services/panelDomains").normalize(process.env.PANEL_NODE_ID).catch((err) =>
        console.error("[Panel] Could not assign legacy domains to this node:", err.message),
    );

    const claims = await panelLease.claimAll();
    const missed = claims.filter((c) => !c.ok);
    if (missed.length) {
        console.warn(`[Panel] Lease not confirmed by: ${missed.map((c) => `${c.name} (${c.error})`).join(", ")}`);
    }

    if (!lifecycle.activate()) {
        console.error("[Panel] A newer panel controls the nodes — background services NOT started.");
        return;
    }
    console.log(`[Panel] Active at epoch ${panelLease.current()}`);
    startBackgroundServices();

    if (incoming) {
        panelMigration.followUp(incoming).catch((err) => console.error("[Move] Follow-up failed:", err.message));
    }
};

// ─────────────────────────────────────────────────────────────────────────────
//  Listen
// ─────────────────────────────────────────────────────────────────────────────
const PORT = parseInt(process.env.PORT) || 3000;
const server = app.listen(PORT, "0.0.0.0", () => {
    console.log(
        `[Server] Bot Panel running on port ${PORT} (${process.env.NODE_ENV || "development"})`,
    );
    bootstrap().catch((err) => console.error("[Panel] Startup failed:", err.message));
});

// Interactive terminal (WebSocket upgrade on /api/term)
termService.attachTermServer(server);
