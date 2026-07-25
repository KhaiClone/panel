import { useState, useEffect, useCallback } from "react";
import api from "../api/client";
import ConfirmModal from "../components/ConfirmModal";

const TYPE_LABEL = { 0: "Avatar", 1: "Profile", 2: "Nameplate", 3: "Frame", 1000: "Bundle" };

const money = (n) => (typeof n === "number" ? n.toLocaleString("vi-VN") + "đ" : "—");

function Field({ label, hint, children }) {
    return (
        <div>
            <label className="label">{label}</label>
            {children}
            {hint && <p style={{ fontSize: 11, color: "var(--text-dim)", marginTop: 4 }}>{hint}</p>}
        </div>
    );
}

function ImportForm({ onImported }) {
    const [deco, setDeco] = useState("");
    const [preview, setPreview] = useState(null);
    const [busy, setBusy] = useState(false);
    const [msg, setMsg] = useState(null); // { ok, text }

    const doPreview = async () => {
        if (!deco.trim()) return;
        setBusy(true); setMsg(null); setPreview(null);
        try {
            const { data } = await api.post("/decors/preview", { deco: deco.trim() });
            setPreview(data.decor);
        } catch (err) {
            setMsg({ ok: false, text: err.response?.data?.message || err.response?.data?.error || "Preview failed" });
        } finally { setBusy(false); }
    };

    const doImport = async () => {
        if (!deco.trim()) return;
        setBusy(true); setMsg(null);
        try {
            const { data } = await api.post("/decors/import", { deco: deco.trim() });
            setMsg({ ok: true, text: `Imported "${data.decor?.name}" (${data.decor?.sku_id})` });
            setDeco(""); setPreview(null);
            onImported();
        } catch (err) {
            setMsg({ ok: false, text: err.response?.data?.message || err.response?.data?.error || "Import failed" });
        } finally { setBusy(false); }
    };

    const previewImg = preview && (preview.type === 1000 ? preview.assetURL?.[0] : (preview.staticURL || preview.assetURL));

    return (
        <div className="card" style={{ padding: 20, display: "flex", flexDirection: "column", gap: 16 }}>
            <div>
                <h3 style={{ fontSize: 15, fontWeight: 700, margin: 0 }}>Import decor</h3>
                <p style={{ fontSize: 12, color: "var(--text-muted)", margin: "4px 0 0" }}>
                    Paste a SKU ID or shop link — the bot auto-fetches all details based on the decor type.
                </p>
            </div>

            <Field label="SKU ID or shop link" hint="e.g. 1491907428344795276 or https://discord.com/shop#itemSkuId=1491907428344795276">
                <input
                    className="input mono"
                    value={deco}
                    onChange={(e) => setDeco(e.target.value)}
                    onKeyDown={(e) => { if (e.key === "Enter") doPreview(); }}
                    placeholder="sku_id or link…"
                />
            </Field>

            {msg && (
                <div style={{ padding: "10px 14px", borderRadius: 8, fontSize: 13, background: msg.ok ? "var(--success-bg)" : "var(--danger-bg)", color: msg.ok ? "var(--success)" : "var(--danger)", border: `1px solid ${msg.ok ? "var(--success-border)" : "var(--danger-border)"}` }}>
                    {msg.text}
                </div>
            )}

            {preview && (
                <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
                        <div style={{ width: 56, height: 56, borderRadius: 10, background: "var(--bg-input)", flexShrink: 0, overflow: "hidden", display: "flex", alignItems: "center", justifyContent: "center" }}>
                            {previewImg ? <img src={previewImg} alt="" style={{ width: "100%", height: "100%", objectFit: "cover" }} onError={(e) => { e.target.style.display = "none"; }} /> : <span style={{ fontSize: 20 }}>🎁</span>}
                        </div>
                        <div style={{ minWidth: 0 }}>
                            <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
                                <span style={{ fontSize: 14, fontWeight: 700 }}>{preview.name}</span>
                                <span className="badge" style={{ fontSize: 9, background: "var(--bg-input)", color: "var(--text-muted)" }}>{TYPE_LABEL[preview.type] ?? preview.type}</span>
                            </div>
                            <p className="mono" style={{ fontSize: 11, color: "var(--text-muted)", margin: "3px 0 0" }}>
                                {money(preview.prices?.withNitro)} (Nitro) · {money(preview.prices?.withoutNitro)}
                            </p>
                        </div>
                    </div>
                    <details>
                        <summary style={{ fontSize: 11, fontWeight: 700, color: "var(--text-dim)", textTransform: "uppercase", cursor: "pointer" }}>Raw data</summary>
                        <pre className="mono" style={{ margin: "6px 0 0", padding: 12, background: "var(--bg-input)", borderRadius: 8, fontSize: 11, maxHeight: 220, overflow: "auto", whiteSpace: "pre-wrap", wordBreak: "break-all" }}>
                            {JSON.stringify(preview, null, 2)}
                        </pre>
                    </details>
                </div>
            )}

            <div style={{ display: "flex", gap: 10, justifyContent: "flex-end" }}>
                <button type="button" className="btn-ghost" disabled={busy || !deco.trim()} onClick={doPreview}>Preview</button>
                <button type="button" className="btn-primary" disabled={busy || !deco.trim()} onClick={doImport}>{busy ? "Processing…" : "Import"}</button>
            </div>
        </div>
    );
}

export default function DecorsPage() {
    const [decors, setDecors] = useState([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState("");
    const [search, setSearch] = useState("");
    const [sourceFilter, setSourceFilter] = useState("all");
    const [confirmDel, setConfirmDel] = useState(null);

    const fetchDecors = useCallback(async () => {
        try {
            const { data } = await api.get("/decors");
            setDecors(Array.isArray(data) ? data : []);
            setError("");
        } catch (err) {
            setError(err.response?.data?.error || err.response?.data?.message || "Could not connect to ArnTo-assistant");
        } finally {
            setLoading(false);
        }
    }, []);

    useEffect(() => { fetchDecors(); }, [fetchDecors]);

    const handleDelete = async () => {
        const sku = confirmDel;
        setConfirmDel(null);
        try {
            await api.delete(`/decors/import/${sku}`);
            fetchDecors();
        } catch (err) {
            alert(err.response?.data?.error || err.response?.data?.message || "Delete failed");
        }
    };

    const visible = decors.filter((d) => {
        const mSrc = sourceFilter === "all" || d.decorFrom === sourceFilter;
        const q = search.trim().toLowerCase();
        const mQ = !q || d.sku_id?.toLowerCase().includes(q) || d.name?.toLowerCase().includes(q);
        return mSrc && mQ;
    });
    const importedCount = decors.filter((d) => d.decorFrom === "importedDecors").length;

    return (
        <div className="fade-in page" style={{ maxWidth: 1400, display: "flex", flexDirection: "column", gap: 20 }}>
            <div>
                <h1 style={{ fontSize: 24, fontWeight: 700, margin: 0, letterSpacing: "-0.02em" }}>Decor (ArnTo-assistant)</h1>
                <p style={{ fontSize: 13, color: "var(--text-muted)", margin: "4px 0 0" }}>Import decors with normalized data matching <code>/decor-load</code>, and manage imported decors.</p>
            </div>

            {error && <div style={{ padding: "12px 16px", borderRadius: 8, background: "var(--danger-bg)", color: "var(--danger)", border: "1px solid var(--danger-border)", fontSize: 13 }}>{error}</div>}

            <div className="grid-1-mobile" style={{ display: "grid", gridTemplateColumns: "minmax(0, 420px) 1fr", gap: 20, alignItems: "start" }}>
                <ImportForm onImported={fetchDecors} />

                <div className="card" style={{ padding: 0, overflow: "hidden" }}>
                    <div style={{ padding: "12px 16px", borderBottom: "1px solid var(--border-light)", display: "flex", flexWrap: "wrap", alignItems: "center", gap: 10 }}>
                        <h3 style={{ fontSize: 14, fontWeight: 700, margin: 0 }}>List ({decors.length})</h3>
                        <span className="badge" style={{ background: "rgba(6,182,212,0.12)", color: "#22d3ee", fontSize: 10 }}>{importedCount} imported</span>
                        <input className="input" style={{ flex: "1 1 160px", maxWidth: 220, padding: "6px 10px", fontSize: 12 }} placeholder="Search sku_id / name…" value={search} onChange={(e) => setSearch(e.target.value)} />
                        <select className="input" style={{ width: "auto", padding: "6px 10px", fontSize: 12 }} value={sourceFilter} onChange={(e) => setSourceFilter(e.target.value)}>
                            <option value="all">All sources</option>
                            <option value="decors">Loaded</option>
                            <option value="importedDecors">Imported</option>
                        </select>
                    </div>
                    <div style={{ maxHeight: 620, overflowY: "auto" }}>
                        {loading ? (
                            <div style={{ padding: 24, textAlign: "center", color: "var(--text-muted)", fontSize: 13 }}>Loading…</div>
                        ) : visible.length === 0 ? (
                            <div style={{ padding: 24, textAlign: "center", color: "var(--text-dim)", fontSize: 13 }}>No decors found.</div>
                        ) : (
                            visible.map((d) => {
                                const img = d.type === 1000 ? (d.assetURL?.[0]) : (d.staticURL || d.assetURL);
                                const imported = d.decorFrom === "importedDecors";
                                return (
                                    <div key={d.sku_id} style={{ display: "flex", alignItems: "center", gap: 12, padding: "10px 16px", borderBottom: "1px solid var(--border-light)" }}>
                                        <div style={{ width: 40, height: 40, borderRadius: 8, background: "var(--bg-input)", flexShrink: 0, overflow: "hidden", display: "flex", alignItems: "center", justifyContent: "center" }}>
                                            {img ? <img src={img} alt="" style={{ width: "100%", height: "100%", objectFit: "cover" }} onError={(e) => { e.target.style.display = "none"; }} /> : <span style={{ fontSize: 16 }}>🎁</span>}
                                        </div>
                                        <div style={{ flex: 1, minWidth: 0 }}>
                                            <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
                                                <span style={{ fontSize: 13, fontWeight: 600, color: "var(--text)" }}>{d.name}</span>
                                                <span className="badge" style={{ fontSize: 9, background: "var(--bg-input)", color: "var(--text-muted)" }}>{TYPE_LABEL[d.type] || d.type}</span>
                                                <span className="badge" style={{ fontSize: 9, background: imported ? "rgba(6,182,212,0.12)" : "rgba(99,102,241,0.12)", color: imported ? "#22d3ee" : "var(--accent-hover)" }}>{imported ? "imported" : "loaded"}</span>
                                            </div>
                                            <p className="mono" style={{ fontSize: 10, color: "var(--text-dim)", margin: "2px 0 0", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{d.sku_id}</p>
                                        </div>
                                        <div style={{ textAlign: "right", flexShrink: 0 }}>
                                            <p className="mono" style={{ fontSize: 11, color: "var(--text-muted)", margin: 0 }}>{money(d.prices?.withNitro)}</p>
                                        </div>
                                        {imported && (
                                            <button className="btn-ghost" style={{ padding: "4px 8px", fontSize: 12, color: "var(--danger)", flexShrink: 0 }} onClick={() => setConfirmDel(d.sku_id)}>Delete</button>
                                        )}
                                    </div>
                                );
                            })
                        )}
                    </div>
                </div>
            </div>

            {confirmDel && (
                <ConfirmModal
                    title={`Delete decor "${confirmDel}"?`}
                    message="Only removes it from importedDecors (manually imported decors). Decors loaded from the shop are not affected."
                    confirmText="Delete"
                    onConfirm={handleDelete}
                    onCancel={() => setConfirmDel(null)}
                />
            )}
        </div>
    );
}
