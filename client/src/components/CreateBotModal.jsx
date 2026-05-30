import { useState, useEffect } from "react";
import { createPortal } from "react-dom";
import api from "../api/client";

// ── Helpers ────────────────────────────────────────────────────────────────

const defaultForm = {
    // common
    source: "git", // "git" | "local"
    buyerID: "",
    botID: "",
    name: "",
    startScript: "npm start",
    expiresAt: "",
    groupId: "",
    maxMemory: "",
    currentPrice: "",
    tags: [],
    // git-only
    repoUrl: "",
    branch: "main",
    // local-only
    localPath: "",
    installCommand: "npm install --omit=dev",
};

const MEM_HINT = 'e.g. "300M", "1G" — leave blank for no limit';

export default function CreateBotModal({ onClose, onCreated }) {
    const [form, setForm] = useState(defaultForm);
    const [groups, setGroups] = useState([]);
    const [availableTags, setAvailableTags] = useState([]);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState("");

    // Fetch groups and tags for the dropdowns
    useEffect(() => {
        api.get("/groups").then((r) => setGroups(r.data)).catch(() => {});
        api.get("/tags").then((r) => setAvailableTags(r.data)).catch(() => {});
    }, []);

    const set = (field) => (e) => {
        const val = e.target.type === "checkbox" ? e.target.checked : e.target.value;
        setForm((f) => ({ ...f, [field]: val }));
    };

    const toggleTag = (tagId) => {
        setForm((f) => ({
            ...f,
            tags: f.tags.includes(tagId) ? f.tags.filter((t) => t !== tagId) : [...f.tags, tagId],
        }));
    };

    const handleSubmit = async (e) => {
        e.preventDefault();
        setError("");
        setLoading(true);

        try {
            const endpoint = form.source === "local" ? "/bots/import-local" : "/bots";
            const payload = form.source === "git"
                ? {
                      buyerID: form.buyerID, botID: form.botID, name: form.name,
                      repoUrl: form.repoUrl, branch: form.branch || "main",
                      startScript: form.startScript || "npm start", installCommand: form.installCommand || null,
                      expiresAt: form.expiresAt ? new Date(form.expiresAt).toISOString() : null,
                      groupId: form.groupId || null, maxMemory: form.maxMemory || null,
                      currentPrice: form.currentPrice ? Number(form.currentPrice) : null,
                      tags: form.tags,
                  }
                : {
                      buyerID: form.buyerID, botID: form.botID, name: form.name,
                      localPath: form.localPath,
                      startScript: form.startScript || "npm start", installCommand: form.installCommand || null,
                      expiresAt: form.expiresAt ? new Date(form.expiresAt).toISOString() : null,
                      groupId: form.groupId || null, maxMemory: form.maxMemory || null,
                      currentPrice: form.currentPrice ? Number(form.currentPrice) : null,
                      tags: form.tags,
                  };

            const { data } = await api.post(endpoint, payload);
            onCreated(data);
            onClose();
        } catch (err) {
            setError(err.response?.data?.error || "Failed to create instance");
        } finally {
            setLoading(false);
        }
    };

    const isGit = form.source === "git";

    return createPortal(
        <div className="modal-overlay">
            <div className="card slide-up" style={{ width: "100%", maxWidth: 650, maxHeight: "90vh", overflowY: "auto", padding: 0, display: "flex", flexDirection: "column" }}>
                
                {/* Header */}
                <div style={{ display: "flex", alignItems: "center", justifyItems: "space-between", padding: "20px 24px", borderBottom: "1px solid var(--border-light)", background: "var(--bg-surface)", position: "sticky", top: 0, zIndex: 10 }}>
                    <div style={{ flex: 1 }}>
                        <h2 style={{ fontSize: 18, fontWeight: 700, color: "var(--text)", margin: 0 }}>Create New Instance</h2>
                        <p style={{ fontSize: 13, color: "var(--text-muted)", marginTop: 4 }}>Deploy a new bot from Git or Local directory</p>
                    </div>
                    <button onClick={onClose} style={{ background: "none", border: "none", color: "var(--text-muted)", cursor: "pointer", fontSize: 20, padding: 4 }}>✕</button>
                </div>

                <form onSubmit={handleSubmit} style={{ padding: 24, display: "flex", flexDirection: "column", gap: 24 }}>
                    
                    {/* Source Toggle */}
                    <div>
                        <label className="label">Source Type</label>
                        <div className="tab-bar" style={{ display: "flex", width: "100%", gap: 4 }}>
                            {["git", "local"].map(s => (
                                <button
                                    key={s} type="button" onClick={() => setForm(f => ({ ...f, source: s }))}
                                    className={`tab-item ${form.source === s ? 'active' : ''}`}
                                    style={{ flex: 1, padding: "12px", fontSize: 14 }}
                                >
                                    {s === "git" ? "🔗 GitHub / Git URL" : "📂 Local Directory"}
                                </button>
                            ))}
                        </div>
                    </div>

                    <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16 }}>
                        <div>
                            <label className="label">Buyer Discord ID *</label>
                            <input className="input" placeholder="123456789012345678" value={form.buyerID} onChange={set("buyerID")} required />
                        </div>
                        <div>
                            <label className="label">Instance ID *</label>
                            <input className="input" placeholder="my-bot-instance" value={form.botID} onChange={set("botID")} required pattern="[a-zA-Z0-9_-]+" title="Letters, numbers, hyphens, underscores only" />
                        </div>
                    </div>

                    <div>
                        <label className="label">Display Name *</label>
                        <input className="input" placeholder="My Awesome Bot" value={form.name} onChange={set("name")} required />
                    </div>

                    {/* Git Fields */}
                    {isGit && (
                        <div style={{ padding: 20, background: "rgba(99,102,241,0.05)", border: "1px solid rgba(99,102,241,0.2)", borderRadius: 12, display: "flex", flexDirection: "column", gap: 16 }}>
                            <div>
                                <label className="label" style={{ color: "var(--accent-hover)" }}>Git Repository URL *</label>
                                <input className="input" placeholder="https://github.com/user/repo.git" value={form.repoUrl} onChange={set("repoUrl")} required={isGit} />
                            </div>
                            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16 }}>
                                <div>
                                    <label className="label">Branch</label>
                                    <input className="input" placeholder="main" value={form.branch} onChange={set("branch")} />
                                </div>
                                <div>
                                    <label className="label">Start Command</label>
                                    <input className="input mono" placeholder="npm start" value={form.startScript} onChange={set("startScript")} />
                                </div>
                            </div>
                            <div>
                                <label className="label">Install Command</label>
                                <input className="input mono" placeholder="npm install --omit=dev" value={form.installCommand} onChange={set("installCommand")} />
                                <p style={{ fontSize: 12, color: "var(--text-muted)", marginTop: 6 }}>Executed after git pull.</p>
                            </div>
                        </div>
                    )}

                    {/* Local Fields */}
                    {!isGit && (
                        <div style={{ padding: 20, background: "var(--bg-input)", border: "1px solid var(--border)", borderRadius: 12, display: "flex", flexDirection: "column", gap: 16 }}>
                            <div>
                                <label className="label">Absolute Path on Server *</label>
                                <input className="input mono" placeholder="/root/bots/my-project" value={form.localPath} onChange={set("localPath")} required={!isGit} />
                            </div>
                            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16 }}>
                                <div>
                                    <label className="label">Start Command</label>
                                    <input className="input mono" placeholder="npm start" value={form.startScript} onChange={set("startScript")} />
                                </div>
                                <div>
                                    <label className="label">Install Command</label>
                                    <input className="input mono" placeholder="npm install --omit=dev" value={form.installCommand} onChange={set("installCommand")} />
                                </div>
                            </div>
                        </div>
                    )}

                    {/* Meta Fields */}
                    <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 16 }}>
                        <div>
                            <label className="label">Group</label>
                            <select className="input" value={form.groupId} onChange={set("groupId")}>
                                <option value="">— Ungrouped —</option>
                                {groups.map(g => <option key={g._id} value={g._id}>{g.name}</option>)}
                            </select>
                        </div>
                        <div>
                            <label className="label">Max Memory</label>
                            <input className="input mono" placeholder="300M" value={form.maxMemory} onChange={set("maxMemory")} pattern="^\d+[KMG]?$" title={MEM_HINT} />
                        </div>
                        <div>
                            <label className="label">Price (Optional)</label>
                            <input type="number" className="input mono" placeholder="Override price" value={form.currentPrice} onChange={set("currentPrice")} disabled={!form.maxMemory} />
                        </div>
                    </div>

                    <div>
                        <label className="label">Expiry Date</label>
                        <input type="datetime-local" className="input" value={form.expiresAt} onChange={set("expiresAt")} />
                    </div>

                    {availableTags.length > 0 && (
                        <div>
                            <label className="label">Tags</label>
                            <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginTop: 8 }}>
                                {availableTags.map(tag => {
                                    const isActive = form.tags.includes(tag._id);
                                    return (
                                        <button
                                            key={tag._id} type="button" onClick={() => toggleTag(tag._id)}
                                            className="badge"
                                            style={{
                                                cursor: "pointer", transition: "all 0.2s",
                                                background: isActive ? `${tag.color}25` : "var(--bg-input)",
                                                border: `1px solid ${isActive ? tag.color + "50" : "var(--border)"}`,
                                                color: isActive ? tag.color : "var(--text-muted)",
                                                padding: "4px 12px"
                                            }}
                                        >
                                            <span style={{ width: 8, height: 8, borderRadius: "50%", background: isActive ? tag.color : "var(--text-dim)", transition: "all 0.2s" }}/>
                                            {tag.name}
                                        </button>
                                    );
                                })}
                            </div>
                        </div>
                    )}

                    {error && <div style={{ padding: "12px 16px", borderRadius: 8, background: "var(--danger-bg)", color: "var(--danger)", border: "1px solid var(--danger-border)" }}>{error}</div>}
                    
                    {loading && (
                        <div style={{ padding: "12px 16px", borderRadius: 8, background: "var(--accent-dim)", color: "var(--accent-hover)", border: "1px solid var(--accent)", display: "flex", alignItems: "center", gap: 12 }}>
                            <div style={{ width: 20, height: 20, borderRadius: "50%", border: "2px solid var(--accent-hover)", borderTopColor: "transparent", animation: "spin 1s linear infinite" }} />
                            {isGit ? "Cloning repository and installing dependencies..." : "Registering instance..."}
                        </div>
                    )}

                    {/* Footer */}
                    <div style={{ display: "flex", justifyContent: "flex-end", gap: 12, paddingTop: 20, borderTop: "1px solid var(--border)" }}>
                        <button type="button" className="btn-ghost" onClick={onClose} disabled={loading} style={{ padding: "10px 20px" }}>Cancel</button>
                        <button type="submit" className="btn-primary" disabled={loading} style={{ padding: "10px 24px" }}>
                            {loading ? "Deploying..." : (isGit ? "🔗 Deploy from Git" : "📂 Deploy Local Instance")}
                        </button>
                    </div>
                </form>
            </div>
        </div>,
        document.body,
    );
}
