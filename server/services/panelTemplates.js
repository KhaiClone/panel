const crypto = require("crypto");
const T = require("../../bot-lib/uiTemplate");
const ui = require("./uiTemplateService");
const defs = require("../templates/panel");

// ─────────────────────────────────────────────────────────────────────────────
//  The panel's own Discord messages as templates — expiry alerts and DMs, the
//  Lavalink report, the backup message (server/templates/panel.js).
//
//  The catalog sits in ui_catalog under the project "__panel" next to the bots',
//  so the Embeds page lists and edits it the same way; rendering happens right
//  here (no polling — the overrides are in this process's database). An admin
//  version that does not parse or breaks a Discord limit falls back to the
//  default, exactly like bot-lib/MessageTemplates.js.
// ─────────────────────────────────────────────────────────────────────────────

const PANEL_ID = ui.PANEL_ID;

for (const [key, def] of Object.entries(defs.templates)) {
    const errs = T.checkMessage(def.message);
    if (errs.length) throw new Error(`[ui] default of "${key}" is broken: ${errs.join("; ")}`);
}

/** Same shape as MessageTemplates.catalog(). */
const catalog = () => {
    const templates = {};
    for (const [key, d] of Object.entries(defs.templates)) {
        templates[key] = {
            kind: "message",
            group: d.group || "Khác",
            label: d.label || key,
            description: d.description || "",
            vars: d.vars || {},
            refreshable: false,
            slotVars: d.slotVars || {},
            default: d.message,
            slots: d.slots || {},
            selects: d.selects || {},
            allowEmpty: !!d.allowEmpty,
        };
    }
    return { types: defs.types || {}, globals: {}, templates };
};
const HASH = crypto.createHash("sha1").update(JSON.stringify(catalog())).digest("hex");

let registered = null;
/** Put the catalog on the Embeds page (on start, and before the first message if that failed). */
const register = () => {
    try {
        ui.saveCatalog(PANEL_ID, { ...catalog(), hash: HASH });
        registered = HASH;
    } catch (e) {
        console.warn(`[ui] panel templates not registered: ${e.message}`);
    }
};

const warned = new Map();
const warn = (key, what) => {
    const k = `${key}:${what}`;
    if (Date.now() - (warned.get(k) || 0) < 10 * 60 * 1000) return;
    warned.set(k, Date.now());
    console.warn(`[ui] ${key}: ${what}`);
};

/**
 * A message ready for a webhook or a DM: { content?, embeds, components? }.
 * @param {string} key   a key of server/templates/panel.js
 * @param {Object} vars  its variables
 */
const message = (key, vars = {}) => {
    if (registered !== HASH) register();
    const def = defs.templates[key];
    if (!def) throw new Error(`[ui] no panel template "${key}"`);
    const scope = [{ bot: null, guild: null, now: Date.now(), custom: ui.customVars() }, vars];
    const over = ui.overrideOf(key);
    for (const [tpl, which] of over ? [[over, "the panel's version"], [def.message, "the default"]] : [[def.message, "the default"]]) {
        try {
            const msg = T.renderMessage(tpl, scope, { slots: def.slots || {}, present: {} });
            const errs = T.validateMessage(msg, { allowEmpty: !!def.allowEmpty });
            if (!errs.length) {
                return {
                    ...(msg.content ? { content: msg.content } : {}),
                    embeds: msg.embeds,
                    ...(msg.components.length ? { components: msg.components } : {}),
                };
            }
            warn(key, `${which} cannot be sent (${errs.join("; ")})`);
        } catch (e) {
            warn(key, `${which} failed: ${e.message}`);
        }
    }
    return { content: `⚠️ ${key}`, embeds: [] };
};

module.exports = { PANEL_ID, catalog, register, message };
