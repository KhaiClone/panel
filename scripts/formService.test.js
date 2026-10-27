#!/usr/bin/env node
/**
 * Checks for the forms of ArnTo-assistant's /form (server/services/formService.js):
 * seeding from the bot's old built-in forms, forms with Discord's limits, the
 * selfbot reminder's size, settings, telling the bot to re-read, and who may
 * use the routes (the settings are the owner's).
 * Run:  node scripts/formService.test.js
 */

const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");
const assert = require("assert");

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "form-test-"));
process.env.SHARED_DB_PATH = path.join(TMP, "shared.sqlite");

// Stand-in for server/db (the page's GET looks up the owner's name).
const dbPath = require.resolve(path.join(__dirname, "..", "server", "db"));
require.cache[dbPath] = {
    id: dbPath,
    filename: dbPath,
    loaded: true,
    exports: { findOne: async (c, q) => (q._id === "assistant" ? { name: "ArnTo-assistant" } : null), find: async () => [], get: async () => null },
};

const sharedStore = require("../server/services/sharedStore");
const discordBus = require("../server/services/discordBus");
const forms = require("../server/services/formService");

const notified = [];
discordBus.canHandle = (botId, cmd) => botId === "assistant" && cmd === "form.refresh";
discordBus.notify = async (botId, cmd, payload) => notified.push({ botId, cmd, payload });

const ROLE = "1246001516893175818";

let failures = 0;
const test = async (name, fn) => {
    try {
        await fn();
        console.log(`  ✓ ${name}`);
    } catch (err) {
        failures++;
        console.log(`  ✗ ${name}\n    ${err.stack}`);
    }
};
const throws = (fn, status) => {
    try {
        fn();
    } catch (err) {
        assert.strictEqual(err.status, status, `expected ${status}, got ${err.status}: ${err.message}`);
        return err;
    }
    throw new Error(`expected a ${status} error`);
};

// What ArnTo-assistant sends the first time it starts (functions/formConfig.js).
const field = (id, label, style = "short") => ({ id, label, description: `${label} desc`, placeholder: `${label}…`, style, required: true });
const IMPORT = {
    forms: [
        { key: "account", name: "Tài khoản", message: "# 📝 Form\n- Tài khoản", note: "Xoá sau {days} ngày", fields: [field("account", "Tài khoản"), field("password", "Mật khẩu")] },
        {
            key: "nicho",
            name: "Nitro (backup Discord)",
            message: "# 📝 Form\n- backup",
            note: "x",
            buttonEmoji: "not-an-emoji",
            fields: [field("account", "Tài khoản"), field("password", "Mật khẩu"), field("backup", "Mã dự phòng", "paragraph")],
            selfbotText: "bạn điền form giúp mình nhen",
        },
        { key: "Có Dấu", name: "bad key", message: "x", fields: [field("a", "A")] },
        { key: "nofields", name: "no fields", message: "x", fields: [] },
    ],
    settings: { viewerRoles: [ROLE, "nope"], retentionDays: 7, defaultKey: "account" },
};

(async () => {
    console.log("formService");

    await test("empty until the bot imports; anyone may read it then", () => {
        const m = forms.get();
        assert.deepStrictEqual([m.imported, m.owner, m.forms.length, m.settings.viewerRoles], [false, null, 0, []]);
        assert.ok(forms.canAccess("anyone"));
    });

    await test("import: the bot's forms and settings; bad ones dropped, not fatal", () => {
        assert.deepStrictEqual(forms.importFrom("assistant", IMPORT), { imported: true, forms: 2 });
        const m = forms.get();
        assert.strictEqual(m.owner, "assistant");
        assert.deepStrictEqual(m.forms.map((f) => f.key), ["account", "nicho"]);
        const nicho = m.forms[1];
        assert.strictEqual(nicho.buttonEmoji, "", "a bad emoji is dropped");
        assert.strictEqual(nicho.buttonLabel, "Mở Form", "the default button label");
        assert.deepStrictEqual(nicho.fields.map((f) => [f.id, f.style]), [["account", "short"], ["password", "short"], ["backup", "paragraph"]]);
        assert.strictEqual(nicho.selfbotText, "bạn điền form giúp mình nhen");
        assert.deepStrictEqual([m.settings.viewerRoles, m.settings.retentionDays, m.settings.defaultKey], [[ROLE], 7, "account"]);
        assert.strictEqual(notified.length, 0, "the bot made it — no refresh");
    });

    await test("import runs once; then only the owner may read the forms", () => {
        assert.deepStrictEqual(forms.importFrom("assistant", IMPORT), { imported: false, forms: 0 });
        assert.ok(forms.canAccess("assistant"));
        assert.ok(!forms.canAccess("shop"));
    });

    await test("forms: validation, Discord's limits, field ids kept across edits", () => {
        const base = { name: "Token", message: "# Token", fields: [field("token", "Token Bot")] };
        throws(() => forms.createForm({ ...base, key: "Có dấu" }), 400);
        throws(() => forms.createForm({ ...base, key: "nicho" }), 409);
        throws(() => forms.createForm({ ...base, key: "t", name: "" }), 400);
        throws(() => forms.createForm({ ...base, key: "t", message: "" }), 400);
        throws(() => forms.createForm({ ...base, key: "t", fields: [] }), 400);
        throws(() => forms.createForm({ ...base, key: "t", fields: Array.from({ length: 6 }, (_, i) => field(`f${i}`, `F${i}`)) }), 400);
        throws(() => forms.createForm({ ...base, key: "t", fields: [field("a", "A"), field("a", "B")] }), 400);
        throws(() => forms.createForm({ ...base, key: "t", fields: [{ label: "" }] }), 400);
        throws(() => forms.createForm({ ...base, key: "t", buttonEmoji: "abc" }), 400);
        throws(() => forms.createForm({ ...base, key: "t", message: "x".repeat(2501) }), 400);
        // The cap is in bytes: 467 × "ờ" (3 bytes each) = 1401 is one too many.
        throws(() => forms.createForm({ ...base, key: "t", selfbotText: "ờ".repeat(467) }), 400);
        forms.createForm({ ...base, key: "edge", selfbotText: "a".repeat(forms.SELFBOT_BYTES) });

        const made = forms.createForm({ ...base, key: "Token", fields: [{ label: "Token Bot", style: "paragraph", required: false }] });
        assert.strictEqual(made.key, "token");
        assert.match(made.fields[0].id, /^[0-9a-f]{8}$/, "a new field gets an id");
        assert.deepStrictEqual([made.fields[0].style, made.fields[0].required, made.modalTitle, made.enabled], ["paragraph", false, "📝 Thông Tin Mật", true]);
        assert.strictEqual(notified.at(-1).cmd, "form.refresh", "a page change tells the bot");

        const id = made.fields[0].id;
        const edited = forms.updateForm("token", { fields: [{ id, label: "Token" }, { label: "Ghi chú", style: "paragraph" }], enabled: false });
        assert.strictEqual(edited.fields[0].id, id, "the id stays");
        assert.deepStrictEqual([edited.fields.length, edited.enabled, edited.message, edited.name], [2, false, "# Token", "Token"]);
        throws(() => forms.updateForm("nope", { name: "x" }), 404);

        let m = forms.moveForm("token", 0);
        assert.deepStrictEqual(m.forms.map((f) => f.key), ["token", "account", "nicho", "edge"]);
        m = forms.deleteForm("edge");
        assert.ok(!m.forms.some((f) => f.key === "edge"));
    });

    await test("settings: default form, viewer roles, retention, texts", () => {
        throws(() => forms.updateSettings({ defaultKey: "nope" }), 404);
        throws(() => forms.updateSettings({ viewerRoles: [] }), 400);
        throws(() => forms.updateSettings({ viewerRoles: ["123"] }), 400);
        throws(() => forms.updateSettings({ retentionDays: 0 }), 400);
        throws(() => forms.updateSettings({ retentionDays: 2.5 }), 400);
        throws(() => forms.updateSettings({ retentionDays: 91 }), 400);
        throws(() => forms.updateSettings({ viewEmoji: "nope" }), 400);
        const m = forms.updateSettings({ defaultKey: "NICHO", viewerRoles: `${ROLE}, 1134354122867482716 ${ROLE}`, retentionDays: "3", savedText: "", doneText: "{staff} xong" });
        assert.deepStrictEqual(
            [m.settings.defaultKey, m.settings.viewerRoles, m.settings.retentionDays, m.settings.savedText, m.settings.doneText],
            ["nicho", [ROLE, "1134354122867482716"], 3, "# ✅ Thông Tin Tài Khoản Đã Được Lưu", "{staff} xong"],
        );
        assert.strictEqual(forms.deleteForm("nicho").settings.defaultKey, "token", "deleting the default picks the first form");
        assert.strictEqual(forms.updateSettings({ defaultKey: "" }).settings.defaultKey, "", "no default: /form asks for a type");
    });

    await test("routes: the page sees the owner's name; another key is refused; settings are the owner's", async () => {
        const express = require("express");
        const app = express();
        app.use(express.json());
        app.use((req, res, next) => {
            req.apiCaller = { botId: req.headers["x-bot"] };
            req.auth = { kind: req.headers["x-kind"] || "owner" };
            next();
        });
        const routes = require("../server/routes/forms");
        app.use("/page", routes.panel);
        app.use("/ext", routes.external);
        const server = app.listen(0);
        const base = `http://127.0.0.1:${server.address().port}`;
        const call = (bot, method, url, body, kind) =>
            new Promise((resolve, reject) => {
                const headers = { "x-bot": bot, "content-type": "application/json", ...(kind ? { "x-kind": kind } : {}) };
                const req = http.request(base + url, { method, agent: false, headers }, (res) => {
                    let data = "";
                    res.on("data", (c) => (data += c));
                    res.on("end", () => resolve({ status: res.statusCode, json: data.startsWith("{") ? JSON.parse(data) : null }));
                });
                req.on("error", reject);
                req.end(body && JSON.stringify(body));
            });
        try {
            assert.strictEqual((await call("", "GET", "/page/")).json.ownerName, "ArnTo-assistant");
            assert.strictEqual((await call("shop", "GET", "/ext/")).status, 403);
            assert.strictEqual((await call("", "GET", "/ext/")).status, 403);
            assert.strictEqual((await call("assistant", "GET", "/ext/")).json.owner, "assistant");
            assert.strictEqual((await call("assistant", "POST", "/ext/items", { key: "x" })).status, 404, "the bot only reads");
            assert.strictEqual((await call("", "POST", "/page/import", {})).status, 404, "import is the bot's");

            const before = notified.length;
            const made = await call("", "POST", "/page/items", { key: "google", name: "Google", message: "# G", fields: [{ label: "Tài khoản" }] });
            assert.strictEqual(made.json.key, "google");
            assert.strictEqual(notified.length, before + 1);
            assert.strictEqual((await call("", "PUT", "/page/items/google", { buttonEmoji: "nope" })).status, 400);
            assert.strictEqual((await call("", "POST", "/page/items/google/move", { position: 0 })).json.forms[0].key, "google");

            const staff = await call("", "PUT", "/page/settings", { viewerRoles: ["1134354122867482716"] }, "staff");
            assert.strictEqual(staff.status, 403);
            assert.deepStrictEqual(forms.get().settings.viewerRoles, [ROLE, "1134354122867482716"], "unchanged");
            assert.strictEqual((await call("", "PUT", "/page/settings", { retentionDays: 5 })).json.settings.retentionDays, 5);
            assert.strictEqual((await call("", "DELETE", "/page/items/google")).status, 200);
        } finally {
            server.closeAllConnections();
            await new Promise((r) => server.close(r));
        }
    });

    sharedStore.close();
    fs.rmSync(TMP, { recursive: true, force: true });
    console.log(failures ? `\n${failures} failed` : "\nall passed");
    process.exit(failures ? 1 : 0);
})();
