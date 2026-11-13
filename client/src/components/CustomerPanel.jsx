import { useEffect, useState } from "react";
import api from "../api/client";
import { Field, Icon, Notice, Toggle } from "./ui";
import CustomerChannels from "./CustomerChannels";

// The project's "Customer" tab (server/services/customerProjects.js). Off by
// default: personal and team projects are left alone. On, the panel looks the
// project's bot and customer up on Discord every day and keeps their names here.

const HEADER = { display: "flex", alignItems: "center", justifyContent: "space-between", gap: 16, marginBottom: 20, paddingBottom: 16, borderBottom: "1px solid var(--border-light)" };
const ROW = { display: "grid", gridTemplateColumns: "140px 1fr", gap: 12, alignItems: "baseline", padding: "8px 0", borderBottom: "1px solid var(--border-light)" };
const KEY = { fontSize: 12, fontWeight: 500, color: "var(--text-muted)" };
const DIM = { fontSize: 12, color: "var(--text-dim)" };

const fmtDate = (ts) => (ts ? new Date(ts).toLocaleString("en-GB") : "—");

const copy = async (text) => {
    try {
        await navigator.clipboard.writeText(text);
        return true;
    } catch {
        return false;
    }
};

function BotIdInput({ botId, value, onChange, tokenKey, disabled }) {
    const [detecting, setDetecting] = useState(false);
    const [found, setFound] = useState(null);
    const [error, setError] = useState("");

    const detect = async () => {
        setDetecting(true);
        setError("");
        setFound(null);
        try {
            const { data } = await api.post(`/customer-projects/${botId}/detect`, { tokenKey });
            onChange(data.botUserId);
            setFound(data.bot);
        } catch (err) {
            setError(err.response?.data?.error || "Could not read the token");
        } finally {
            setDetecting(false);
        }
    };

    return (
        <Field
            label="Bot ID"
            hint={found
                ? `Found ${found.name} (@${found.username}) in the token.`
                : "The bot's numeric Discord ID. Detect reads it from the bot token in the project's .env — the token itself never leaves the panel."}
        >
            <div style={{ display: "flex", gap: 8 }}>
                <input
                    className="input mono"
                    placeholder="e.g. 1480411893448573009"
                    value={value}
                    onChange={(e) => { onChange(e.target.value.trim()); setFound(null); }}
                    disabled={disabled}
                    style={{ flex: 1, minWidth: 0 }}
                />
                <button type="button" className="btn-ghost btn-sm" onClick={detect} disabled={disabled || detecting}>
                    <Icon name="key" size={14} /> {detecting ? "Reading…" : "Detect from token"}
                </button>
            </div>
            {error && <span style={{ fontSize: 12, color: "var(--danger)" }}>{error}</span>}
        </Field>
    );
}

export default function CustomerPanel({ bot, onChanged }) {
    const c = bot.customer || {};
    const on = !!c.enabled;

    const [status, setStatus] = useState(null);
    const [form, setForm] = useState(null); // the "turn on" form while it is open
    const [botUserId, setBotUserId] = useState(c.botUserId || "");
    const [tokenKey, setTokenKey] = useState(c.envKeys?.token || "TOKEN");
    const [busy, setBusy] = useState(null);
    const [msg, setMsg] = useState(null);
    const [copied, setCopied] = useState(false);

    useEffect(() => {
        api.get("/customer-projects/status").then((r) => setStatus(r.data)).catch(() => {});
    }, []);

    // Keep the inputs on what is saved when the record changes elsewhere.
    useEffect(() => {
        setBotUserId(c.botUserId || "");
        setTokenKey(c.envKeys?.token || "TOKEN");
    }, [c.botUserId, c.envKeys?.token]);

    // expectLookup: the server looks the names up after this change — when it
    // could not (the panel's bot is offline), say so instead of "done".
    const run = async (name, call, okText, expectLookup = false) => {
        setBusy(name);
        setMsg(null);
        try {
            const { data } = await call();
            if (data?.error) setMsg({ tone: "warning", text: data.error });
            else if (expectLookup && data?.synced === false)
                setMsg({ tone: "info", text: "Saved. The names will be looked up once the panel's Discord bot is connected." });
            else if (okText) setMsg({ tone: "success", text: okText });
            setForm(null);
            onChanged?.();
        } catch (err) {
            setMsg({ tone: "danger", text: err.response?.data?.error || "Something went wrong" });
        } finally {
            setBusy(null);
        }
    };

    const enable = () =>
        run("enable", () => api.post(`/customer-projects/${bot._id}/enable`, {
            botUserId: botUserId || null,
            tokenKey,
            syncName: form?.syncName !== false,
        }), "This is now a customer project.", true);

    const disable = () =>
        run("disable", () => api.post(`/customer-projects/${bot._id}/disable`), "Turned off — the panel leaves this project alone again.");

    const save = () =>
        run("save", () => api.put(`/customer-projects/${bot._id}`, { botUserId: botUserId || null, tokenKey }), "Saved.",
            (botUserId || "") !== (c.botUserId || ""));

    const setSync = (syncName) =>
        run("sync", () => api.put(`/customer-projects/${bot._id}`, { syncName }),
            syncName ? "The name follows the bot on Discord again." : "The name is yours now — it will not follow Discord.", syncName);

    const refresh = () =>
        run("refresh", () => api.post(`/customer-projects/${bot._id}/refresh`), "Looked up on Discord just now.", true);

    const busDown = status && !status.busReady;
    const dirty = (botUserId || "") !== (c.botUserId || "") || tokenKey !== (c.envKeys?.token || "TOKEN");

    return (
        <div style={{ display: "flex", flexDirection: "column", gap: 24 }}>
        <div className="card">
            <div style={HEADER}>
                <div>
                    <h2 style={{ fontSize: 16, fontWeight: 600, color: "var(--text)", margin: 0 }}>Customer project</h2>
                    <p style={{ fontSize: 13, color: "var(--text-muted)", marginTop: 4 }}>
                        {on
                            ? "The panel looks this project's bot and customer up on Discord every day at 04:00 (Vietnam time)."
                            : "Off — the panel leaves this project alone. Turn it on only for a customer's project; personal and team projects stay off."}
                    </p>
                </div>
                <Toggle
                    checked={on || !!form}
                    disabled={!!busy}
                    title={on ? "Stop treating this as a customer project" : "Mark as a customer project"}
                    onChange={(v) => (v ? setForm({ syncName: true }) : on ? disable() : setForm(null))}
                />
            </div>

            {busDown && (
                <div style={{ marginBottom: 16 }}>
                    <Notice tone="warning">The panel's Discord bot is not connected — names are not looked up until it is.</Notice>
                </div>
            )}
            {msg && (
                <div style={{ marginBottom: 16 }}>
                    <Notice tone={msg.tone}>{msg.text}</Notice>
                </div>
            )}

            {!on && form && (
                <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
                    <BotIdInput botId={bot._id} value={botUserId} onChange={setBotUserId} tokenKey={tokenKey} disabled={!!busy} />
                    <Field label="Token key in .env" hint="The .env key holding the bot token — TOKEN in template-discord-bot.">
                        <input className="input mono" value={tokenKey} onChange={(e) => setTokenKey(e.target.value.trim())} disabled={!!busy} style={{ maxWidth: 260 }} />
                    </Field>
                    <label style={{ display: "flex", alignItems: "center", gap: 10, fontSize: 13, color: "var(--text)" }}>
                        <Toggle checked={form.syncName !== false} onChange={(v) => setForm((f) => ({ ...f, syncName: v }))} />
                        Name the project after its bot on Discord
                    </label>
                    <p style={DIM}>
                        No bot (a website, a service)? Leave the Bot ID empty — the customer is still looked up from the Client ID ({bot.buyerID}).
                    </p>
                    <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
                        <button type="button" className="btn-ghost" onClick={() => setForm(null)} disabled={!!busy}>Cancel</button>
                        <button type="button" className="btn-primary" onClick={enable} disabled={!!busy}>
                            {busy === "enable" ? "Turning on…" : "Turn on"}
                        </button>
                    </div>
                </div>
            )}

            {on && (
                <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
                    <div>
                        <div style={ROW}>
                            <span style={KEY}>Bot</span>
                            <span>
                                {c.botUserId
                                    ? <>{c.botName || "—"}{c.botUsername && <span style={DIM}> @{c.botUsername}</span>} <span className="mono" style={DIM}>· {c.botUserId}</span></>
                                    : <span style={DIM}>No bot</span>}
                            </span>
                        </div>
                        <div style={ROW}>
                            <span style={KEY}>Customer</span>
                            <span>
                                {c.buyerDisplayName || "—"}{c.buyerName && <span style={DIM}> @{c.buyerName}</span>} <span className="mono" style={DIM}>· {bot.buyerID}</span>
                            </span>
                        </div>
                        <div style={ROW}>
                            <span style={KEY}>Base name</span>
                            <span style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0 }}>
                                <span className="mono" style={{ overflowWrap: "anywhere" }}>{c.baseName || "—"}</span>
                                {c.baseName && (
                                    <button type="button" className="btn-ghost btn-icon btn-sm" title="Copy" onClick={async () => { if (await copy(c.baseName)) { setCopied(true); setTimeout(() => setCopied(false), 1500); } }}>
                                        <Icon name={copied ? "check" : "copy"} size={14} />
                                    </button>
                                )}
                            </span>
                        </div>
                        <div style={ROW}>
                            <span style={KEY}>Last looked up</span>
                            <span style={{ fontSize: 13 }}>{fmtDate(c.checkedAt)}</span>
                        </div>
                        <p style={{ ...DIM, marginTop: 8 }}>
                            The base name is what this project's log and backup channels are called, and what a new repo for it should be called. Repos are never renamed when a name changes.
                        </p>
                    </div>

                    {c.lastError && <Notice tone="warning">{c.lastError}</Notice>}

                    <label style={{ display: "flex", alignItems: "flex-start", gap: 10, fontSize: 13, color: "var(--text)" }}>
                        <Toggle checked={!!c.syncName} disabled={!!busy || !c.botUserId} onChange={setSync} />
                        <span>
                            The project's name follows its bot on Discord
                            <span style={{ ...DIM, display: "block", marginTop: 2 }}>
                                {c.botUserId ? "Renaming the project by hand turns this off." : "Needs a bot ID."}
                            </span>
                        </span>
                    </label>

                    <div className="grid-1-mobile" style={{ display: "grid", gridTemplateColumns: "2fr 1fr", gap: 16, alignItems: "start" }}>
                        <BotIdInput botId={bot._id} value={botUserId} onChange={setBotUserId} tokenKey={tokenKey} disabled={!!busy} />
                        <Field label="Token key in .env" hint="TOKEN in template-discord-bot.">
                            <input className="input mono" value={tokenKey} onChange={(e) => setTokenKey(e.target.value.trim())} disabled={!!busy} />
                        </Field>
                    </div>

                    <div style={{ display: "flex", gap: 8, flexWrap: "wrap", justifyContent: "flex-end" }}>
                        <button type="button" className="btn-ghost" onClick={refresh} disabled={!!busy || busDown}>
                            <Icon name="refresh" size={14} /> {busy === "refresh" ? "Looking up…" : "Refresh now"}
                        </button>
                        <button type="button" className="btn-primary" onClick={save} disabled={!!busy || !dirty}>
                            {busy === "save" ? "Saving…" : "Save"}
                        </button>
                    </div>
                </div>
            )}
        </div>
        {on && <CustomerChannels bot={bot} onChanged={onChanged} />}
        </div>
    );
}
