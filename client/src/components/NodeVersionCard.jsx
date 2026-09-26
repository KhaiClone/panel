import { useCallback, useEffect, useState } from "react";
import api from "../api/client";

// ─────────────────────────────────────────────────────────────────────────────
//  NodeVersionCard — pin one project to an exact Node.js version.
//
//  The choice is per project and applies on the project's own node: install,
//  build, start and the project's terminal all run that version. The agent
//  downloads a version the first time a node needs it (see the agent's
//  services/nodeVersions.js); "System default" is whatever `node` the node has.
// ─────────────────────────────────────────────────────────────────────────────

const Spinner = () => (
    <div style={{ width: 14, height: 14, borderRadius: "50%", border: "2px solid currentColor", borderTopColor: "transparent", animation: "spin 0.8s linear infinite", flexShrink: 0 }} />
);

export default function NodeVersionCard({ bot, onSaved, onMessage }) {
    const current = bot.nodeVersion || "";
    const [info, setInfo] = useState(null); // { system, installed[], available[], supported }
    const [loadError, setLoadError] = useState("");
    const [choice, setChoice] = useState(current);
    const [saving, setSaving] = useState(false);

    const load = useCallback(async () => {
        setLoadError("");
        try {
            const { data } = await api.get(`/bots/${bot._id}/node-versions`);
            setInfo(data);
        } catch (err) {
            setLoadError(err.response?.data?.error || "Could not read Node versions from this project's node");
        }
    }, [bot._id, bot.nodeId]); // nodeId: after a migration the installed list is another machine's

    useEffect(() => { load(); }, [load]);
    // Follow the saved value (the page re-polls the bot), not every re-render.
    useEffect(() => { setChoice(current); }, [current]);

    const installed = info?.installed || [];
    const downloadable = (info?.available || []).filter((r) => !installed.includes(r.version));
    const needsDownload = !!choice && !installed.includes(choice);
    // A pin can point at a version this node does not have yet (after a move to
    // another node); keep it selectable so the form still shows the truth.
    const orphanPin = current && !installed.includes(current) && !downloadable.some((r) => r.version === current);

    const apply = async () => {
        setSaving(true);
        try {
            const { data } = await api.put(`/bots/${bot._id}/node-version`, { nodeVersion: choice || null }, { timeout: 400_000 });
            const what = choice ? `Node v${choice}` : `the system Node${info?.system ? ` (v${info.system})` : ""}`;
            onMessage?.({
                type: "success",
                text: `${bot.name} now uses ${what}${data.downloaded ? " — downloaded to this node" : ""}.` +
                    (data.restarted ? " The running instance was restarted on it." : " It takes effect on the next start or install."),
            });
            onSaved?.();
            load();
        } catch (err) {
            onMessage?.({ type: "error", text: err.response?.data?.error || "Could not change the Node version" });
        } finally {
            setSaving(false);
        }
    };

    return (
        <div className="card">
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, marginBottom: 16, paddingBottom: 14, borderBottom: "1px solid var(--border-light)" }}>
                <div>
                    <h3 style={{ fontSize: 16, fontWeight: 600, color: "var(--text)", margin: 0 }}>Node.js Version</h3>
                    <p style={{ fontSize: 13, color: "var(--text-muted)", marginTop: 4 }}>Used for install, build, start and this project's terminal</p>
                </div>
                <span className="mono badge" style={{ background: "var(--bg-input)", color: "var(--text-dim)", border: "1px solid var(--border)", whiteSpace: "nowrap" }}>
                    {current ? `v${current}` : `system${info?.system ? ` · v${info.system}` : ""}`}
                </span>
            </div>

            {loadError ? (
                <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
                    <p style={{ fontSize: 13, color: "var(--danger)", margin: 0, flex: 1, minWidth: 0 }}>{loadError}</p>
                    <button className="btn-ghost" style={{ padding: "6px 12px", fontSize: 12 }} onClick={load}>Retry</button>
                </div>
            ) : !info ? (
                <p style={{ fontSize: 13, color: "var(--text-muted)", margin: 0 }}>Loading versions…</p>
            ) : info.supported === false ? (
                <p style={{ fontSize: 13, color: "var(--text-muted)", margin: 0 }}>
                    This node cannot run pinned versions — nodejs.org publishes no build for its platform. Projects here use the system Node.
                </p>
            ) : (
                <>
                    <div className="mobile-stack" style={{ display: "flex", gap: 10, alignItems: "center" }}>
                        <select className="input mono" style={{ maxWidth: 360 }} value={choice} onChange={(e) => setChoice(e.target.value)} disabled={saving}>
                            <option value="">System default{info.system ? ` (v${info.system})` : ""}</option>
                            {(installed.length > 0 || orphanPin) && (
                                <optgroup label="On this node">
                                    {installed.map((v) => <option key={v} value={v}>v{v}</option>)}
                                    {orphanPin && <option value={current}>v{current} (not on this node yet)</option>}
                                </optgroup>
                            )}
                            {downloadable.length > 0 && (
                                <optgroup label="Download from nodejs.org">
                                    {downloadable.map((r) => (
                                        <option key={r.version} value={r.version}>
                                            v{r.version} — Node {r.major}{r.lts ? ` LTS (${r.lts})` : ""}
                                        </option>
                                    ))}
                                </optgroup>
                            )}
                        </select>
                        <button
                            className="btn-primary"
                            style={{ padding: "9px 18px", display: "flex", alignItems: "center", gap: 8, whiteSpace: "nowrap" }}
                            disabled={saving || choice === current}
                            onClick={apply}
                        >
                            {saving ? <><Spinner /> {needsDownload ? "Downloading…" : "Applying…"}</> : "Apply"}
                        </button>
                    </div>
                    <p style={{ fontSize: 12, color: "var(--text-muted)", margin: "12px 0 0", lineHeight: 1.55 }}>
                        A version is downloaded once per node (about 50 MB, ~200 MB unpacked) and verified against nodejs.org's checksums.
                        A running instance restarts onto it; a stopped one stays stopped. If the project uses native modules
                        (better-sqlite3, canvas, sharp…), run <strong>Pull &amp; Update</strong> afterwards so they are rebuilt for the new version.
                    </p>
                </>
            )}
        </div>
    );
}
