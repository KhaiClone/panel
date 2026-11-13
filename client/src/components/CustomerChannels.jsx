import { useEffect, useState } from "react";
import api from "../api/client";
import ConfirmModal from "./ConfirmModal";
import { Icon, Notice } from "./ui";

// The Kho log/backup channels of a customer project (server/services/customerChannels.js),
// inside the project's Customer tab. The webhook URLs live only in the project's .env.

const KINDS = [
    { kind: "log", label: "Log channel", key: "logKey", def: "WEBHOOK_LOG" },
    { kind: "backup", label: "Backup channel", key: "backupKey", def: "WEBHOOK_BACKUP" },
];
const ROW = { display: "grid", gridTemplateColumns: "130px 1fr auto", gap: 12, alignItems: "center", padding: "10px 0", borderBottom: "1px solid var(--border-light)" };
const DIM = { fontSize: 12, color: "var(--text-dim)" };
const CHIP = (tone) => ({ fontSize: 11, padding: "1px 8px", borderRadius: 999, background: `var(--${tone}-bg)`, color: `var(--${tone})`, border: `1px solid var(--${tone}-border)` });

const discordUrl = (c) => `https://discord.com/channels/${c.guildId}/${c.channelId}`;

export default function CustomerChannels({ bot, onChanged }) {
    const c = bot.customer || {};
    const channels = c.channels || {};
    const keyOf = (k) => c.envKeys?.[k.kind] || k.def;

    const [keys, setKeys] = useState({ logKey: keyOf(KINDS[0]), backupKey: keyOf(KINDS[1]) });
    const [busy, setBusy] = useState(null);
    const [msg, setMsg] = useState(null); // { tone, text }
    const [taken, setTaken] = useState(null); // ENV_TAKEN details
    const [confirmReplace, setConfirmReplace] = useState(false);
    const [results, setResults] = useState(null); // link results
    const [restart, setRestart] = useState(null); // null | "offer" | "running" | "done"
    const [pending, setPending] = useState(null); // what ENV_TAKEN interrupted: { action: "setup" } | { action: "reuse", retiredId }
    const [reusable, setReusable] = useState([]); // this bot's channels from when it was retired

    useEffect(() => {
        setKeys({ logKey: keyOf(KINDS[0]), backupKey: keyOf(KINDS[1]) });
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [c.envKeys?.log, c.envKeys?.backup]);

    const usable = (k) => channels[k]?.channelId && !channels[k].missing;
    const todo = KINDS.filter((k) => !usable(k.kind));
    const todoKey = todo.map((k) => k.kind).join(",");

    // A customer back with the same bot: offer its old channels before making new ones.
    useEffect(() => {
        if (!todoKey || !c.botUserId) {
            setReusable([]);
            return;
        }
        api.get(`/customer-projects/${bot._id}/reusable`).then((r) => setReusable(r.data)).catch(() => setReusable([]));
    }, [bot._id, c.botUserId, todoKey]);
    const keysDirty = keys.logKey !== keyOf(KINDS[0]) || keys.backupKey !== keyOf(KINDS[1]);

    const go = async (name, fn) => {
        setBusy(name);
        setMsg(null);
        setResults(null);
        try {
            await fn();
            onChanged?.();
        } catch (err) {
            const d = err.response?.data || {};
            if (d.code === "ENV_TAKEN") setTaken(d.taken || []);
            else setMsg({ tone: "danger", text: d.error || "Something went wrong" });
        } finally {
            setBusy(null);
        }
    };

    const reuseOld = (retiredId, replace = false) =>
        go("reuse", async () => {
            setConfirmReplace(false);
            setPending({ action: "reuse", retiredId });
            const { data } = await api.post(`/customer-projects/${bot._id}/channels/reuse`, { retiredId, replace }, { timeout: 60_000 });
            setTaken(null);
            setPending(null);
            const names = data.reused.map((k) => `#${data.bot.customer.channels[k].name} (${k})`).join(" and ");
            setMsg({ tone: "success", text: `Back in use: ${names}, renamed after this project, with new webhooks in the .env — restart the project so it uses them.` });
            setRestart("offer");
        });

    const setUp = (replace = false) =>
        go("setup", async () => {
            setConfirmReplace(false);
            setPending({ action: "setup" });
            const { data } = await api.post(`/customer-projects/${bot._id}/channels`, { kinds: todo.map((k) => k.kind), replace }, { timeout: 60_000 });
            setTaken(null);
            setPending(null);
            const made = data.created.map((k) => `#${data.bot.customer.channels[k].name} (${k})`).join(" and ");
            const written = data.created.map((k) => data.bot.customer.envKeys?.[k] || KINDS.find((x) => x.kind === k).def).join(" and ");
            setMsg({ tone: "success", text: `Created ${made}. ${written} ${data.created.length > 1 ? "are" : "is"} in the project's .env — restart the project so it uses ${data.created.length > 1 ? "them" : "it"}.` });
            setRestart("offer");
        });

    const link = () =>
        go("link", async () => {
            const { data } = await api.post(`/customer-projects/${bot._id}/channels/link`, { kinds: todo.map((k) => k.kind) });
            setTaken(null);
            setResults(data.results);
            if (data.error) setMsg({ tone: "warning", text: data.error });
        });

    const unlink = (kind) =>
        go(`unlink-${kind}`, async () => {
            await api.delete(`/customer-projects/${bot._id}/channels/${kind}`);
            setMsg({ tone: "success", text: "Unlinked. The channel and the .env are untouched." });
        });

    const saveKeys = () =>
        go("keys", async () => {
            await api.put(`/customer-projects/${bot._id}`, keys);
            setMsg({ tone: "success", text: "Saved the .env key names." });
        });

    const restartNow = async () => {
        setRestart("running");
        try {
            await api.post(`/bots/${bot._id}/restart`);
            setRestart("done");
        } catch (err) {
            setRestart(null);
            setMsg({ tone: "danger", text: err.response?.data?.error || "Restart failed" });
        }
    };

    return (
        <div className="card">
            {confirmReplace && (
                <ConfirmModal
                    title={pending?.action === "reuse" ? "Reuse the old channels and replace the .env values?" : "Make new channels and replace the .env values?"}
                    message={`${taken.map((t) => t.key).join(" and ")} in the project's .env will point to ${pending?.action === "reuse" ? "the old channels" : "the new channels"}. The channels they point to now are left as they are.`}
                    confirmText="Replace"
                    danger={false}
                    onConfirm={() => (pending?.action === "reuse" ? reuseOld(pending.retiredId, true) : setUp(true))}
                    onCancel={() => setConfirmReplace(false)}
                />
            )}

            <div style={{ marginBottom: 12, paddingBottom: 16, borderBottom: "1px solid var(--border-light)" }}>
                <h2 style={{ fontSize: 16, fontWeight: 600, color: "var(--text)", margin: 0 }}>Log & backup channels</h2>
                <p style={{ fontSize: 13, color: "var(--text-muted)", marginTop: 4 }}>
                    A log and a backup channel in Kho, made by the panel's bot. The project posts there with webhooks kept in its .env — the panel stores
                    only the channel ids. The channels are named <span className="mono">{c.baseName || "after the project"}</span> and follow that name.
                </p>
            </div>

            {msg && (
                <div style={{ marginBottom: 12 }}>
                    <Notice tone={msg.tone}>
                        <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
                            <span style={{ flex: 1, minWidth: 0 }}>{msg.text}</span>
                            {restart === "offer" && (
                                <button type="button" className="btn-ghost btn-sm" onClick={restartNow}>
                                    <Icon name="restart" size={14} /> Restart now
                                </button>
                            )}
                            {restart === "running" && <span style={DIM}>Restarting…</span>}
                            {restart === "done" && <span style={DIM}>Restarted.</span>}
                        </div>
                    </Notice>
                </div>
            )}

            {taken && (
                <div style={{ marginBottom: 12 }}>
                    <Notice tone="warning">
                        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                            <span>The project's .env already has a webhook for this:</span>
                            <ul style={{ margin: 0, paddingLeft: 18 }}>
                                {taken.map((t) => (
                                    <li key={t.kind} style={{ fontSize: 13 }}>
                                        <span className="mono">{t.key}</span>{" "}
                                        {t.channelName ? <>posts to <b>#{t.channelName}</b>{t.guildName ? ` in ${t.guildName}` : ""}</> : <span style={DIM}>— {t.error || "unknown channel"}</span>}
                                    </li>
                                ))}
                            </ul>
                            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                                <button type="button" className="btn-primary btn-sm" onClick={link} disabled={!!busy}>Link those channels</button>
                                <button type="button" className="btn-ghost btn-sm" onClick={() => setConfirmReplace(true)} disabled={!!busy}>
                                    {pending?.action === "reuse" ? "Reuse the old ones anyway" : "Create new ones instead"}
                                </button>
                                <button type="button" className="btn-ghost btn-sm" onClick={() => setTaken(null)} disabled={!!busy}>Cancel</button>
                            </div>
                        </div>
                    </Notice>
                </div>
            )}

            {!taken && reusable.map((r) => (
                <div key={r.retiredId} style={{ marginBottom: 12 }}>
                    <Notice tone="info">
                        <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
                            <span style={{ flex: 1, minWidth: 0 }}>
                                This bot had channels before — {Object.entries(r.channels).map(([k, ch]) => `#${ch.name} (${k})`).join(" and ")},
                                kept since "{r.name}" was retired on {new Date(r.retiredAt).toLocaleDateString("en-GB")}. Reuse them to keep its history in one place.
                            </span>
                            <button type="button" className="btn-primary btn-sm" onClick={() => reuseOld(r.retiredId)} disabled={!!busy}>
                                {busy === "reuse" ? "Reusing…" : "Reuse them"}
                            </button>
                        </div>
                    </Notice>
                </div>
            ))}

            {results && (
                <div style={{ marginBottom: 12 }}>
                    <Notice tone={results.some((r) => r.status === "linked") ? "success" : "warning"}>
                        <ul style={{ margin: 0, paddingLeft: 18 }}>
                            {results.map((r) => (
                                <li key={r.kind} style={{ fontSize: 13 }}>
                                    <span className="mono">{r.key}</span>: {r.status === "linked" ? `linked #${r.channelName}` : `not linked — ${r.reason}`}
                                </li>
                            ))}
                        </ul>
                    </Notice>
                </div>
            )}

            <div>
                {KINDS.map((k) => {
                    const ch = channels[k.kind];
                    return (
                        <div key={k.kind} style={ROW}>
                            <span style={{ fontSize: 12, fontWeight: 500, color: "var(--text-muted)" }}>{k.label}</span>
                            <span style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", minWidth: 0 }}>
                                {ch?.channelId ? (
                                    <>
                                        <a href={discordUrl(ch)} target="_blank" rel="noreferrer" className="mono" style={{ overflowWrap: "anywhere" }}>
                                            #{ch.name || ch.channelId}
                                        </a>
                                        {ch.missing && <span style={CHIP("danger")}>Deleted on Discord</span>}
                                        {ch.webhookMissing && <span style={CHIP("warning")}>Webhook deleted</span>}
                                    </>
                                ) : (
                                    <span style={DIM}>Not set up</span>
                                )}
                                <span className="mono" style={DIM}>· {keyOf(k)}</span>
                            </span>
                            {ch?.channelId ? (
                                <button type="button" className="btn-ghost btn-sm" onClick={() => unlink(k.kind)} disabled={!!busy} title="Stop managing this channel — it stays on Discord">
                                    Unlink
                                </button>
                            ) : <span />}
                        </div>
                    );
                })}
            </div>

            {todo.length > 0 && (
                <div style={{ display: "flex", gap: 8, flexWrap: "wrap", justifyContent: "flex-end", marginTop: 16 }}>
                    <button type="button" className="btn-ghost" onClick={link} disabled={!!busy} title="Adopt the channels this project's .env already posts to — they are renamed to the base name">
                        <Icon name="plug" size={14} /> {busy === "link" ? "Linking…" : "Link from .env"}
                    </button>
                    <button type="button" className="btn-primary" onClick={() => setUp(false)} disabled={!!busy}>
                        <Icon name="plus" size={14} /> {busy === "setup" ? "Setting up…" : todo.length > 1 ? "Set up channels" : `Set up the ${todo[0].kind} channel`}
                    </button>
                </div>
            )}

            <div style={{ display: "flex", gap: 12, alignItems: "flex-end", flexWrap: "wrap", marginTop: 20 }}>
                {KINDS.map((k) => (
                    <label key={k.kind} style={{ display: "flex", flexDirection: "column", gap: 6, flex: "1 1 180px" }}>
                        <span style={{ fontSize: 12, fontWeight: 500, color: "var(--text-muted)" }}>{k.label} key in .env</span>
                        <input className="input mono" value={keys[k.key]} onChange={(e) => setKeys((s) => ({ ...s, [k.key]: e.target.value.trim() }))} disabled={!!busy} />
                    </label>
                ))}
                <button type="button" className="btn-ghost" onClick={saveKeys} disabled={!!busy || !keysDirty}>Save keys</button>
            </div>
            <p style={{ ...DIM, marginTop: 8 }}>{KINDS.map((k) => k.def).join(" / ")} in template-discord-bot. Change them for a project that reads other names.</p>
        </div>
    );
}
