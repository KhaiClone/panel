const express = require("express");
const router = express.Router();

const db = require("../db");
const store = require("../services/lavalinkStore");
const lavalink = require("../services/lavalinkService");
const updater = require("../services/lavalinkUpdater");
const { renderYaml, sha256, effective, applyEdits, describeUnsupported, parseYaml } = require("../services/lavalinkConfig");

// Mounted behind authMiddleware (see index.js). The panel has one account, so a
// valid token is full access — same as every other route here.

const withNode = (handler) => async (req, res, next) => {
    try {
        const node = await db.findOne("nodes", { _id: req.params.id });
        if (!node) return res.status(404).json({ error: "Node not found" });
        await handler(node, req, res);
    } catch (err) {
        next(err);
    }
};

/**
 * GET /api/lavalink
 * Settings + what we know about the latest release. The release lookup is
 * best-effort: GitHub being unreachable must not blank out the page.
 */
router.get("/", async (req, res, next) => {
    try {
        const settings = await store.get();
        let release = null;
        try {
            release = await lavalink.latestRelease();
        } catch (err) {
            release = { error: err.message };
        }
        // `effective` is what the nodes actually run: with a hand-written
        // application.yml the form fields in `settings` describe nothing.
        res.json({ settings, effective: effective(settings), release, schedule: updater.SCHEDULE });
    } catch (err) {
        next(err);
    }
});

/**
 * PUT /api/lavalink/settings   body: { ...patch, sync?: boolean }
 * `sync: true` pushes the new application.yml to every node right away,
 * restarting the ones that are running.
 */
router.put("/settings", async (req, res, next) => {
    try {
        const { sync, configEdits, ...patch } = req.body || {};
        const before = await store.get();

        // Two ways to change the same config, and they compose in one save:
        // `yamlOverride` is the document itself, `configEdits` are the form
        // fields applied ON TOP of it — spliced over the exact bytes they
        // replace, so a hand-tuned file keeps its comments and layout.
        let edited = null;
        if (configEdits && Object.keys(configEdits).length) {
            const base = typeof patch.yamlOverride === "string" && patch.yamlOverride.trim()
                ? patch.yamlOverride
                : before.yamlOverride;
            if (!base || !base.trim()) {
                return res.status(400).json({
                    error: "configEdits only applies while a custom application.yml is in use",
                });
            }
            edited = applyEdits(base, configEdits);
            patch.yamlOverride = edited.yaml;
        }

        const settings = await store.update(patch);

        // The daily job is armed with a timezone; changing it has to re-arm.
        if (patch.timezone && patch.timezone !== before.timezone) await updater.start();

        const result = sync ? await lavalink.syncAll({ restart: true }) : null;
        res.json({
            settings,
            effective: effective(settings),
            sync: result,
            // Tell the UI when a field had to be INSERTED rather than replaced:
            // that path had no bytes to splice over, so the file was rewritten.
            edit: edited ? { reformatted: edited.reformatted, inserted: edited.inserted } : null,
        });
    } catch (err) {
        next(err);
    }
});

/**
 * POST /api/lavalink/mode/file
 * Switch to editing application.yml directly. The editor is seeded with the
 * file the nodes are running right now, so the switch changes nothing by itself.
 */
router.post("/mode/file", async (req, res, next) => {
    try {
        const current = await store.get();
        if (current.yamlOverride) {
            return res.json({ settings: current, effective: effective(current), alreadyCustom: true });
        }
        const settings = await store.update({ yamlOverride: renderYaml(current) });
        res.json({ settings, effective: effective(settings), alreadyCustom: false });
    } catch (err) {
        next(err);
    }
});

/**
 * POST /api/lavalink/mode/form   body: { confirm?: boolean }
 * Switch back to the panel's form fields.
 *
 * The form can only render what it models, so anything else in the file is
 * about to be lost — plugin settings blocks, a proxy, a source with no
 * checkbox. Without `confirm` this only REPORTS what would go, and the page
 * asks first: silently dropping a Spotify secret on a button press would be
 * the worst possible outcome here.
 */
router.post("/mode/form", async (req, res, next) => {
    try {
        const current = await store.get();
        if (!current.yamlOverride) {
            return res.json({ settings: current, effective: effective(current), switched: true, dropped: [] });
        }

        const { error, dropped } = describeUnsupported(current.yamlOverride);
        if (error) return res.status(400).json({ error });

        if (!req.body?.confirm) {
            return res.json({ switched: false, dropped, preview: true });
        }

        // Carry the file's values into the form so the switch does not also
        // reset the port and password the bots are using.
        const parsed = parseYaml(current.yamlOverride);
        const patch = { yamlOverride: null };
        if (parsed.port !== null) patch.port = parsed.port;
        if (parsed.address !== null) patch.address = parsed.address;
        if (parsed.password) patch.password = parsed.password;
        if (parsed.plugins.length) patch.plugins = parsed.plugins;
        if (Object.keys(parsed.sources).length) patch.sources = parsed.sources;
        if (Object.keys(parsed.filters).length) patch.filters = parsed.filters;

        const settings = await store.update(patch);
        res.json({ settings, effective: effective(settings), switched: true, dropped });
    } catch (err) {
        next(err);
    }
});

/** GET /api/lavalink/yaml — the exact application.yml the nodes should hold. */
router.get("/yaml", async (req, res, next) => {
    try {
        const yaml = renderYaml(await store.get());
        res.json({ yaml, sha: sha256(yaml) });
    } catch (err) {
        next(err);
    }
});

/** GET /api/lavalink/status — per-node state, plus the config sha they should match. */
router.get("/status", async (req, res, next) => {
    try {
        res.json(await lavalink.statusAll());
    } catch (err) {
        next(err);
    }
});

/** POST /api/lavalink/sync   body: { restart } */
router.post("/sync", async (req, res, next) => {
    try {
        res.json(await lavalink.syncAll({ restart: req.body?.restart !== false }));
    } catch (err) {
        next(err);
    }
});

/**
 * POST /api/lavalink/check-update
 * Runs exactly what the 02:00 job runs, now.
 */
router.post("/check-update", async (req, res, next) => {
    try {
        res.json(await updater.run({ manual: true }));
    } catch (err) {
        next(err);
    }
});

/**
 * POST /api/lavalink/nodes/:id/install   body: { start?: boolean }
 * First-time setup (or a clean reinstall). `start: false` prepares the node
 * without launching Lavalink.
 */
router.post("/nodes/:id/install", withNode(async (node, req, res) => {
    res.json(await lavalink.installOnNode(node, { start: req.body?.start !== false }));
}));

/** POST /api/lavalink/nodes/:id/update — bring one node to the latest release. */
router.post("/nodes/:id/update", withNode(async (node, req, res) => {
    const release = await lavalink.latestRelease({ force: true });
    res.json(await lavalink.updateNode(node, release));
}));

/** POST /api/lavalink/nodes/:id/sync — push the config to one node. */
router.post("/nodes/:id/sync", withNode(async (node, req, res) => {
    res.json(await lavalink.syncNode(node, { restart: req.body?.restart !== false }));
}));

/** POST /api/lavalink/nodes/:id/:action — start | stop | restart | rollback */
router.post("/nodes/:id/:action", withNode(async (node, req, res) => {
    const { action } = req.params;
    if (!["start", "stop", "restart", "rollback"].includes(action)) {
        return res.status(400).json({ error: `Unknown action "${action}"` });
    }
    res.json(await lavalink.control(node, action));
}));

/** GET /api/lavalink/nodes/:id/logs?lines=100 */
router.get("/nodes/:id/logs", withNode(async (node, req, res) => {
    const lines = Math.min(parseInt(req.query.lines) || 100, 500);
    res.json(await lavalink.logs(node, lines));
}));

module.exports = router;
