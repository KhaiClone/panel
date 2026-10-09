// ─────────────────────────────────────────────────────────────────────────────
//  Panel Settings → Integrations: how projects reach the panel (API keys, the
//  gateway on every node) and how the panel reaches them (the Discord bus).
// ─────────────────────────────────────────────────────────────────────────────
import { useState, useEffect, useCallback } from "react";
import api from "../../api/client";
import ConfirmModal from "../../components/ConfirmModal";
import { useData } from "../../context/DataContext";
import Section from "./Section";

// ── API keys: one per project calling /api/external ─────────────────────────

const fmtWhen = (ts) => (ts ? new Date(ts).toLocaleString() : "never");

function ApiKeysSection() {
    const { bots } = useData();
    const [data, setData] = useState(null);
    const [form, setForm] = useState({ botId: "", label: "", envKey: "PANEL_API_KEY", writeEnv: true, setUrl: true, urlKey: "PANEL_API_URL" });
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState("");
    const [created, setCreated] = useState(null); // { record, key?, wroteEnv? }
    const [restart, setRestart] = useState(null); // null | "running" | "done" | error text
    const [revokeConfirm, setRevokeConfirm] = useState(null);

    const load = useCallback(() => {
        api.get("/panel/api-keys").then((r) => setData(r.data)).catch((err) => setError(err.response?.data?.error || "Failed to load API keys"));
    }, []);
    useEffect(load, [load]);

    const create = async () => {
        setBusy(true); setError(""); setCreated(null); setRestart(null);
        try {
            const { setUrl, ...rest } = form;
            const { data: r } = await api.post("/panel/api-keys", { ...rest, urlKey: setUrl ? form.urlKey : null }, { timeout: 60_000 });
            setCreated(r);
            setForm((f) => ({ ...f, botId: "", label: "" }));
            load();
        } catch (err) {
            setError(err.response?.data?.error || "Failed to create the key");
        } finally { setBusy(false); }
    };

    const revoke = async (id) => {
        setRevokeConfirm(null); setError("");
        try { const { data: r } = await api.delete(`/panel/api-keys/${id}`); setData(r); }
        catch (err) { setError(err.response?.data?.error || "Failed to revoke"); }
    };

    const restartProject = async (botId) => {
        setRestart("running");
        try { await api.post(`/bots/${botId}/restart`); setRestart("done"); }
        catch (err) { setRestart(err.response?.data?.error || "Restart failed"); }
    };

    if (!data) return <p style={{ fontSize: 13, color: "var(--text-muted)", margin: 0 }}>{error || "Loading…"}</p>;
    const active = data.keys.filter((k) => !k.revokedAt);
    const revoked = data.keys.filter((k) => k.revokedAt);

    return (
        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
            {revokeConfirm && (
                <ConfirmModal
                    title={`Revoke key ${revokeConfirm.prefix}…`}
                    message={`${revokeConfirm.botName || "The project"} can no longer call the panel with this key, and its callbacks fall back to the shared PANEL_API_KEY.`}
                    confirmText="Revoke"
                    onConfirm={() => revoke(revokeConfirm._id)}
                    onCancel={() => setRevokeConfirm(null)}
                />
            )}
            <p style={{ fontSize: 12, color: "var(--text-muted)", margin: 0 }}>
                Give every project that calls the panel's external API its own key instead of the shared PANEL_API_KEY. The panel then knows
                who registered each callback: a <span className="mono">localhost</span> callback follows that project to whatever node it runs on,
                and is signed with the project's key. Moving the panel or the project needs no .env change.
            </p>
            {error && <p style={{ fontSize: 12, color: "var(--danger)", margin: 0 }}>{error}</p>}

            <div className="card" style={{ padding: 12, display: "flex", flexDirection: "column", gap: 8 }}>
                <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                    <select className="input" value={form.botId} onChange={(e) => setForm({ ...form, botId: e.target.value })} style={{ flex: "1 1 220px", minWidth: 0 }}>
                        <option value="">— choose the project —</option>
                        {bots.map((b) => <option key={b._id} value={b._id}>{b.name} ({b.pm2Name})</option>)}
                    </select>
                    <input className="input" placeholder="label (optional)" value={form.label} onChange={(e) => setForm({ ...form, label: e.target.value })} style={{ flex: "1 1 140px", minWidth: 0 }} />
                </div>
                <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
                    <label style={{ fontSize: 12, color: "var(--text-muted)", display: "flex", alignItems: "center", gap: 6 }}>
                        <input type="checkbox" checked={form.writeEnv} onChange={(e) => setForm({ ...form, writeEnv: e.target.checked })} />
                        Write it into the project's .env as
                    </label>
                    <input className="input mono" value={form.envKey} disabled={!form.writeEnv} onChange={(e) => setForm({ ...form, envKey: e.target.value })} style={{ width: 170 }} />
                    <label style={{ fontSize: 12, color: "var(--text-muted)", display: "flex", alignItems: "center", gap: 6 }} title="Points the project at the panel gateway on its own node — no panel address in its .env">
                        <input type="checkbox" checked={form.writeEnv && form.setUrl} disabled={!form.writeEnv} onChange={(e) => setForm({ ...form, setUrl: e.target.checked })} />
                        and
                    </label>
                    <input className="input mono" value={form.urlKey} disabled={!form.writeEnv || !form.setUrl} onChange={(e) => setForm({ ...form, urlKey: e.target.value })} style={{ width: 150 }} />
                    <span style={{ fontSize: 12, color: "var(--text-muted)" }}>= panel gateway</span>
                    <button className="btn-primary" disabled={!form.botId || busy} onClick={create} style={{ padding: "6px 12px", fontSize: 12, marginLeft: "auto" }}>
                        {busy ? "Creating…" : "Create key"}
                    </button>
                </div>
            </div>

            {created?.wroteEnv && (
                <div className="card" style={{ padding: 12, borderColor: "var(--success)", fontSize: 12, display: "flex", flexWrap: "wrap", gap: 8, alignItems: "center" }}>
                    <span>
                        ✅ Written to <strong>{created.record.botName}</strong>'s .env as <span className="mono">{created.wroteEnv}</span>
                        {created.gateway && <>, with <span className="mono">{created.gateway.key}={created.gateway.url}</span></>}. It takes effect when the project restarts.
                    </span>
                    <button className="btn-ghost" disabled={restart === "running" || restart === "done"} onClick={() => restartProject(created.record.botId)} style={{ padding: "4px 10px", fontSize: 12, marginLeft: "auto" }}>
                        {restart === "running" ? "Restarting…" : restart === "done" ? "Restarted ✓" : `Restart ${created.record.botName} now`}
                    </button>
                    {restart && restart !== "running" && restart !== "done" && <span style={{ color: "var(--danger)", width: "100%" }}>{restart}</span>}
                </div>
            )}
            {created?.key && (
                <div className="card" style={{ padding: 12, borderColor: "var(--warning)", fontSize: 12, display: "flex", flexDirection: "column", gap: 6 }}>
                    <span>Key for <strong>{created.record.botName}</strong> — shown once, copy it now:</span>
                    <div style={{ display: "flex", gap: 8 }}>
                        <input className="input mono" readOnly value={created.key} onFocus={(e) => e.target.select()} style={{ flex: 1, minWidth: 0 }} />
                        <button className="btn-ghost" onClick={() => navigator.clipboard?.writeText(created.key)} style={{ padding: "4px 10px", fontSize: 12 }}>Copy</button>
                    </div>
                </div>
            )}

            {active.length > 0 && (
                <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                    {active.map((k) => (
                        <div key={k._id} className="card" style={{ padding: "8px 12px", display: "flex", gap: 10, alignItems: "baseline", flexWrap: "wrap", fontSize: 12 }}>
                            <strong style={{ color: "var(--text)" }}>{k.botName || "deleted project"}</strong>
                            {k.label !== k.botName && <span style={{ color: "var(--text-muted)" }}>{k.label}</span>}
                            <span className="mono" style={{ color: "var(--text-dim)" }}>{k.prefix}…</span>
                            <span style={{ color: "var(--text-dim)", marginLeft: "auto" }}>created {fmtWhen(k.createdAt)} · last used {fmtWhen(k.lastUsedAt)}</span>
                            <button className="btn-ghost" onClick={() => setRevokeConfirm(k)} style={{ padding: "2px 8px", fontSize: 11, color: "var(--danger)" }}>Revoke</button>
                        </div>
                    ))}
                </div>
            )}
            {revoked.length > 0 && (
                <p style={{ fontSize: 11, color: "var(--text-dim)", margin: 0 }}>
                    Revoked: {revoked.map((k) => `${k.botName || "?"} ${k.prefix}…`).join(", ")}
                </p>
            )}
            {!data.sharedKey && active.length === 0 && (
                <p style={{ fontSize: 12, color: "var(--text-muted)", margin: 0 }}>PANEL_API_KEY is not set and no project has a key — the external API refuses everyone.</p>
            )}

            {data.callbacks.length > 0 && (
                <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                    <span style={{ fontSize: 11, fontWeight: 700, textTransform: "uppercase", color: "var(--text-muted)" }}>Localhost callbacks the panel holds</span>
                    {data.callbacks.map((c) => (
                        <div key={`${c.url}|${c.ownerBotId}`} style={{ fontSize: 12, display: "flex", gap: 8, flexWrap: "wrap" }}>
                            <span className="mono" style={{ color: "var(--text-dim)", overflowWrap: "anywhere" }}>{c.url}</span>
                            <span style={{ color: "var(--text-muted)" }}>{c.sources.join(", ")}</span>
                            {c.ownerBotId
                                ? <span style={{ color: "var(--success)" }}>→ follows {c.ownerName}</span>
                                : <span style={{ color: "var(--warning)" }}>→ no known project: pinned to this node when the panel moves</span>}
                        </div>
                    ))}
                </div>
            )}
        </div>
    );
}

// ── Panel gateway: every node's 127.0.0.1:4201 door to the panel ─────────────

function PanelGatewaySection() {
    const [rows, setRows] = useState(null);
    const [error, setError] = useState("");
    const load = useCallback(() => {
        setError("");
        api.get("/panel/gateway", { timeout: 60_000 }).then((r) => setRows(r.data.nodes)).catch((err) => setError(err.response?.data?.error || "Failed to load"));
    }, []);
    useEffect(load, [load]);

    return (
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            <p style={{ fontSize: 12, color: "var(--text-muted)", margin: 0 }}>
                Projects call the panel's API at <span className="mono">http://127.0.0.1:4201</span> on whatever node they run on. The agent there
                forwards to the panel holding its node — so neither moving the panel nor migrating a project needs a .env change.
                Set it with <strong>API Keys</strong> above (PANEL_API_URL).
            </p>
            {error && <p style={{ margin: 0, fontSize: 12, color: "var(--danger)" }}>{error}</p>}
            {!rows ? (
                !error && <p style={{ margin: 0, fontSize: 12, color: "var(--text-dim)" }}>Loading…</p>
            ) : (
                <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                    {rows.map((g) => {
                        const ok = g.listening && g.panelUrl && g.reach?.ok;
                        const why = g.error
                            ? g.error
                            : !g.listening
                              ? "not listening"
                              : !g.panelUrl
                                ? "does not know the panel yet"
                                : g.reach?.ok
                                  ? `→ ${g.panelUrl}`
                                  : `→ ${g.panelUrl} unreachable (${g.reach?.error || "?"})`;
                        return (
                            <div key={g.nodeId} style={{ display: "flex", gap: 8, fontSize: 12, alignItems: "baseline", flexWrap: "wrap" }}>
                                <span>{ok ? "✅" : "⚠️"}</span>
                                <strong style={{ color: "var(--text)" }}>{g.name}</strong>
                                {g.localUrl && <span className="mono" style={{ color: "var(--text-dim)" }}>{g.localUrl}</span>}
                                <span className="mono" style={{ color: ok ? "var(--text-muted)" : "var(--warning)", overflowWrap: "anywhere" }}>{why}</span>
                            </div>
                        );
                    })}
                </div>
            )}
            <div><button className="btn-ghost" onClick={load} style={{ padding: "4px 10px", fontSize: 12 }}>Refresh</button></div>
        </div>
    );
}

// ── Shared data + the Discord bus ───────────────────────────────────────────
// Data the bots and the panel both use lives on the panel (bots call it through
// their gateway); commands to the bots go through a private Discord channel.

const BUS_STATUS_COLOR = { done: "var(--success)", failed: "var(--danger)", sent: "var(--accent)", queued: "var(--text-muted)" };

function SharedDataSection() {
    const { bots } = useData();
    const [data, setData] = useState(null);
    const [error, setError] = useState("");
    const [form, setForm] = useState({ botId: "", name: "", kind: "collection" });
    const [busy, setBusy] = useState(null);
    const [note, setNote] = useState("");

    const load = useCallback(() => {
        api.get("/panel/shared").then((r) => { setData(r.data); setError(""); }).catch((err) => setError(err.response?.data?.error || "Failed to load"));
    }, []);
    useEffect(load, [load]);

    const act = (key, fn) => async () => {
        setBusy(key); setNote(""); setError("");
        try { setNote(await fn()); load(); }
        catch (err) { setError(err.response?.data?.error || err.message); }
        finally { setBusy(null); }
    };

    const declare = act("declare", async () => {
        await api.post("/panel/shared/declare", form);
        setForm((f) => ({ ...f, name: "" }));
        return `"${form.name}" reserved — the project moves its copy here on its next start (PANEL_SHARED)`;
    });
    const ping = (botId, name) => act(`ping:${botId}`, async () => {
        const { data: r } = await api.post("/panel/shared/ping", { botId }, { timeout: 40_000 });
        return `${name} answered over Discord in ${r.ms} ms`;
    });
    const publish = act("publish", async () => (await api.post("/panel/shared/decor-site/publish", {}, { timeout: 120_000 })).data.message);

    if (!data) return <p style={{ fontSize: 13, color: "var(--text-muted)", margin: 0 }}>{error || "Loading…"}</p>;
    const { bus, names, capabilities, recent, decorSite } = data;

    return (
        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
            <p style={{ fontSize: 12, color: "var(--text-muted)", margin: 0 }}>
                Data a bot and the panel both use is kept here: the bot lists the names in <span className="mono">PANEL_SHARED</span> and reads/writes
                them through its gateway — the panel never calls a bot. When the panel needs a bot to act (complete an order, send a DM…), it posts
                a signed command in a private Discord channel and the bot replies there.
            </p>
            {error && <p style={{ margin: 0, fontSize: 12, color: "var(--danger)" }}>{error}</p>}
            {note && <p style={{ margin: 0, fontSize: 12, color: "var(--success)" }}>{note}</p>}

            <div style={{ fontSize: 12, display: "flex", gap: 8, flexWrap: "wrap", alignItems: "baseline" }}>
                <strong style={{ color: "var(--text)" }}>Discord bus</strong>
                {!bus.configured ? (
                    <span style={{ color: "var(--text-muted)" }}>off — set PANEL_DISCORD_TOKEN and PANEL_BUS_CHANNEL_ID in .env</span>
                ) : bus.ready ? (
                    <span style={{ color: "var(--success)" }}>✅ {bus.botTag} on channel <span className="mono">{bus.channelId}</span></span>
                ) : (
                    <span style={{ color: "var(--warning)" }}>⚠️ not connected{bus.error ? ` — ${bus.error}` : ""}</span>
                )}
                {Object.entries(bus.counts || {}).map(([k, n]) => <span key={k} style={{ color: "var(--text-dim)" }}>{k}: {n}</span>)}
            </div>

            {capabilities.length > 0 && (
                <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                    {capabilities.map((c) => (
                        <div key={c.botId} style={{ display: "flex", gap: 8, fontSize: 12, alignItems: "baseline", flexWrap: "wrap" }}>
                            <strong style={{ color: "var(--text)" }}>{c.name || c.botId}</strong>
                            <span className="mono" style={{ color: "var(--text-dim)", overflowWrap: "anywhere" }}>{c.commands.join(", ")}</span>
                            <span style={{ color: "var(--text-dim)" }}>· seen {new Date(c.at).toLocaleString()}</span>
                            <button className="btn-ghost" disabled={!bus.ready || busy === `ping:${c.botId}`} onClick={ping(c.botId, c.name)} style={{ padding: "2px 8px", fontSize: 11, marginLeft: "auto" }}>
                                {busy === `ping:${c.botId}` ? "Pinging…" : "Ping"}
                            </button>
                        </div>
                    ))}
                </div>
            )}

            <div style={{ border: "1px solid var(--border)", borderRadius: 8, overflow: "hidden" }}>
                {names.length === 0 ? (
                    <div style={{ padding: 12, fontSize: 12, color: "var(--text-dim)" }}>No shared data yet.</div>
                ) : names.map((n, i) => (
                    <div key={n.name} style={{ display: "flex", gap: 10, padding: "8px 12px", fontSize: 12, alignItems: "baseline", flexWrap: "wrap", borderBottom: i < names.length - 1 ? "1px solid var(--border-light)" : "none" }}>
                        <strong className="mono" style={{ color: "var(--text)" }}>{n.name}</strong>
                        <span style={{ color: "var(--text-dim)" }}>{n.kind}</span>
                        <span style={{ color: "var(--text-muted)" }}>{n.ownerName || n.owner}</span>
                        <span style={{ marginLeft: "auto", color: n.state === "active" ? "var(--success)" : "var(--warning)" }}>
                            {n.state === "active" ? `${n.kind === "collection" ? `${n.count} records` : n.count ? "set" : "empty"}` : "waiting for the project to move it here"}
                        </span>
                    </div>
                ))}
            </div>

            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                <select className="input" value={form.botId} onChange={(e) => setForm({ ...form, botId: e.target.value })} style={{ flex: "1 1 200px", minWidth: 0 }}>
                    <option value="">— owning project —</option>
                    {bots.map((b) => <option key={b._id} value={b._id}>{b.name} ({b.pm2Name})</option>)}
                </select>
                <input className="input mono" placeholder="name (e.g. orders)" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value.trim() })} style={{ flex: "1 1 140px", minWidth: 0 }} />
                <select className="input" value={form.kind} onChange={(e) => setForm({ ...form, kind: e.target.value })} style={{ width: 130 }}>
                    <option value="collection">collection</option>
                    <option value="value">value</option>
                </select>
                <button className="btn-primary" disabled={!form.botId || !form.name || busy === "declare"} onClick={declare} style={{ padding: "6px 12px", fontSize: 12 }}>Declare</button>
            </div>

            <div style={{ fontSize: 12, display: "flex", gap: 8, flexWrap: "wrap", alignItems: "baseline" }}>
                <strong style={{ color: "var(--text)" }}>Decor site</strong>
                {decorSite.configured ? (
                    <span style={{ color: "var(--text-muted)" }}>
                        publishes to <span className="mono">{decorSite.repo}</span>
                        {decorSite.last?.at ? ` · last: ${decorSite.last.ok ? "✅" : "❌"} ${decorSite.last.message} (${new Date(decorSite.last.at).toLocaleString()})` : " · nothing published yet"}
                    </span>
                ) : (
                    <span style={{ color: "var(--text-muted)" }}>off — set DECOR_SITE_GITHUB_TOKEN (Contents: read & write on the site repo) in .env</span>
                )}
                {decorSite.configured && (
                    <button className="btn-ghost" disabled={busy === "publish"} onClick={publish} style={{ padding: "2px 8px", fontSize: 11, marginLeft: "auto" }}>
                        {busy === "publish" ? "Publishing…" : "Publish now"}
                    </button>
                )}
            </div>

            {recent.length > 0 && (
                <details>
                    <summary style={{ fontSize: 12, color: "var(--text-muted)", cursor: "pointer" }}>Recent commands ({recent.length})</summary>
                    <div style={{ display: "flex", flexDirection: "column", gap: 2, marginTop: 6 }}>
                        {recent.map((r) => (
                            <div key={r.id} style={{ display: "flex", gap: 8, fontSize: 11, flexWrap: "wrap" }}>
                                <span style={{ color: "var(--text-dim)" }}>{new Date(r.createdAt).toLocaleString()}</span>
                                <span style={{ color: "var(--text-muted)" }}>{r.targetName || r.target}</span>
                                <span className="mono">{r.cmd}</span>
                                <span style={{ color: BUS_STATUS_COLOR[r.status] || "var(--text-muted)" }}>{r.status}</span>
                                {r.error && <span style={{ color: "var(--danger)", overflowWrap: "anywhere" }}>{r.error}</span>}
                            </div>
                        ))}
                    </div>
                </details>
            )}
            <div><button className="btn-ghost" onClick={load} style={{ padding: "4px 10px", fontSize: 12 }}>Refresh</button></div>
        </div>
    );
}

export default function IntegrationsTab() {
    return (
        <>
            <Section icon="🔑" title="API Keys" hint="One per project calling the external API">
                <ApiKeysSection />
            </Section>
            <Section icon="🚪" title="Panel Gateway" hint="127.0.0.1:4201 on every node">
                <PanelGatewaySection />
            </Section>
            <Section icon="🗄️" title="Shared Data & Discord Bus" hint="Bots call the panel; the panel talks to them on Discord">
                <SharedDataSection />
            </Section>
        </>
    );
}
