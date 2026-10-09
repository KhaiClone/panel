import { useState, useEffect } from "react";
import { createPortal } from "react-dom";
import api from "../api/client";
import { Icon } from "./ui";

// ── Helpers ────────────────────────────────────────────────────────────────

const defaultForm = {
    // common
    source: "git",
    projectType: "discord",
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
    // website-only
    websiteMode: "static",
    websitePort: "",
    websiteApiPort: "",
    buildCommand: "npm run build",
    distFolder: ".",
    // service-only
    servicePort: "",
    // placement
    nodeId: "auto",
};

const MEM_HINT = 'e.g. "300M", "1G" — leave blank for no limit';

const SECTION = { padding: 16, background: "var(--bg-surface)", border: "1px solid var(--border)", borderRadius: 10, display: "flex", flexDirection: "column", gap: 16 };
const SECTION_TITLE = { fontSize: 13, fontWeight: 600, color: "var(--text)", margin: 0 };

// ── Sub-components ─────────────────────────────────────────────────────────

function TabBar({ value, onChange, options }) {
    return (
        <div className="tab-bar" style={{ display: "flex", width: "100%", gap: 4 }}>
            {options.map(({ key, label, icon }) => (
                <button
                    key={key} type="button"
                    onClick={() => onChange(key)}
                    className={`tab-item ${value === key ? "active" : ""}`}
                    style={{ flex: 1, padding: "8px 10px", display: "inline-flex", alignItems: "center", justifyContent: "center", gap: 8 }}
                >
                    {icon && <Icon name={icon} size={15} />}
                    {label}
                </button>
            ))}
        </div>
    );
}

export default function CreateBotModal({ onClose, onCreated, defaultProjectType }) {
    const [form, setForm] = useState(() => ({
        ...defaultForm,
        projectType: defaultProjectType || defaultForm.projectType,
        // Remote view active → default the placement to the node being viewed
        nodeId: defaultForm.nodeId,
    }));
    const [groups, setGroups] = useState([]);
    const [availableTags, setAvailableTags] = useState([]);
    const [nodes, setNodes] = useState([]);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState("");

    useEffect(() => {
        api.get("/groups").then((r) => setGroups(r.data)).catch(() => {});
        api.get("/tags").then((r) => setAvailableTags(r.data)).catch(() => {});
        api.get("/nodes").then((r) => setNodes(r.data)).catch(() => {});
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

            const websiteConfig = form.projectType === "website"
                ? {
                      mode: form.websiteMode,
                      port: form.websitePort || undefined,
                      apiPort: form.websiteMode === "fullstack" ? form.websiteApiPort : undefined,
                      buildCommand: isStatic ? null : (form.buildCommand || null),
                      distFolder: form.distFolder || (isStatic ? "." : "dist"),
                  }
                : undefined;

            const serviceConfig = form.projectType === "service" && form.servicePort
                ? { port: form.servicePort }
                : undefined;

            const common = {
                buyerID: form.buyerID,
                botID: form.botID,
                name: form.name,
                startScript: form.projectType === "website" && form.websiteMode === "static"
                    ? undefined
                    : (form.startScript || "npm start"),
                installCommand: isStatic ? null : (form.installCommand || null),
                expiresAt: form.expiresAt ? new Date(form.expiresAt).toISOString() : null,
                groupId: form.groupId || null,
                maxMemory: form.maxMemory || null,
                currentPrice: form.currentPrice ? Number(form.currentPrice) : null,
                tags: form.tags,
                projectType: form.projectType,
                websiteConfig,
                serviceConfig,
                // Node placement — admin + git-deployed projects (local imports
                // physically live on the panel VPS)
                nodeId: form.source === "git" ? form.nodeId : undefined,
            };

            const payload = form.source === "git"
                ? { ...common, repoUrl: form.repoUrl, branch: form.branch || "main" }
                : { ...common, localPath: form.localPath };

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
    const isWebsite = form.projectType === "website";
    const isService = form.projectType === "service";
    const isFullstack = isWebsite && form.websiteMode === "fullstack";
    const isStatic = isWebsite && form.websiteMode === "static";

    const deployLabel = isGit ? "Deploy from Git" : "Import local";

    return createPortal(
        <div className="modal-overlay">
            <div className="card slide-up modal-card-mobile" style={{ width: "100%", maxWidth: 680, maxHeight: "92vh", overflowY: "auto", padding: 0, display: "flex", flexDirection: "column" }}>

                {/* Header */}
                <div style={{ display: "flex", alignItems: "center", padding: "16px 20px", borderBottom: "1px solid var(--border)", background: "var(--bg-card)", position: "sticky", top: 0, zIndex: 10 }}>
                    <div style={{ flex: 1 }}>
                        <h2 style={{ fontSize: 16, fontWeight: 600, color: "var(--text)", margin: 0 }}>New project</h2>
                        <p style={{ fontSize: 13, color: "var(--text-muted)", margin: "2px 0 0" }}>Deploy a project from Git or a local directory</p>
                    </div>
                    <button type="button" onClick={onClose} className="btn-ghost btn-icon" style={{ border: "none" }} title="Close">
                        <Icon name="x" />
                    </button>
                </div>

                <form onSubmit={handleSubmit} style={{ padding: 20, display: "flex", flexDirection: "column", gap: 20 }}>

                    {/* ── Project Type ─────────────────────────────────── */}
                    <div>
                        <label className="label">Project Type</label>
                        <TabBar
                            value={form.projectType}
                            onChange={(v) => setForm((f) => ({ ...f, projectType: v }))}
                            options={[
                                { key: "discord", label: "Discord bot", icon: "bots" },
                                { key: "website", label: "Website", icon: "globe" },
                                { key: "service", label: "Service", icon: "servers" },
                            ]}
                        />
                        {isService && (
                            <p style={{ fontSize: 12, color: "var(--text-muted)", marginTop: 8 }}>
                                For Lavalink, Java servers, or any process that needs a port opened. PM2 manages the process.
                            </p>
                        )}
                    </div>

                    {/* ── Website Mode (only for website) ──────────────── */}
                    {isWebsite && (
                        <div style={{ ...SECTION, gap: 0 }}>
                            <label className="label">Website mode</label>
                            <TabBar
                                value={form.websiteMode}
                                onChange={(v) => setForm((f) => ({
                                ...f,
                                websiteMode: v,
                                distFolder: v === "static" ? "." : "dist",
                                installCommand: v === "static" ? "" : "npm install --omit=dev",
                            }))}
                                options={[
                                    { key: "static", label: "Static (nginx serves dist)" },
                                    { key: "fullstack", label: "Full-stack (PM2 + nginx)" },
                                ]}
                            />
                            <p style={{ fontSize: 12, color: "var(--text-muted)", margin: "10px 0 0" }}>
                                {isStatic
                                    ? "nginx serves the build output directly. No running process needed."
                                    : "PM2 runs your API server. nginx serves the frontend dist and proxies /api requests."}
                            </p>
                        </div>
                    )}

                    {/* ── Source Toggle ─────────────────────────────────── */}
                    <div>
                        <label className="label">Source Type</label>
                        <TabBar
                            value={form.source}
                            onChange={(v) => setForm((f) => ({ ...f, source: v }))}
                            options={[
                                { key: "git", label: "Git repository", icon: "proxy" },
                                { key: "local", label: "Local directory", icon: "folder" },
                            ]}
                        />
                    </div>

                    {/* ── Node Placement (git-deployed projects) ── */}
                    {form.source === "git" && nodes.length > 1 && (
                        <div>
                            <label className="label">Node (VPS)</label>
                            <select className="input" value={form.nodeId} onChange={set("nodeId")}>
                                <option value="auto">Auto — panel picks the least-loaded node</option>
                                {nodes.map((n) => {
                                    const ramFree = n.stats?.memory ? `${Math.round(100 - n.stats.memory.usedPercent)}% RAM free` : "no stats";
                                    const diskFree = n.stats?.disk ? `${(n.stats.disk.freeBytes / 1073741824).toFixed(0)}GB disk free` : "";
                                    const offline = n.status !== "online";
                                    return (
                                        <option key={n._id} value={n._id} disabled={offline}>
                                            {n.name}{offline ? " (offline)" : ` — ${ramFree}${diskFree ? `, ${diskFree}` : ""}`}
                                        </option>
                                    );
                                })}
                            </select>
                            <p style={{ fontSize: 12, color: "var(--text-muted)", marginTop: 6 }}>
                                Auto keeps websites/services on the panel VPS; pick a node to place them there explicitly. Local imports always run on the panel VPS.
                            </p>
                        </div>
                    )}

                    {/* ── Identity ──────────────────────────────────────── */}
                    <div className="grid-1-mobile" style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16 }}>
                        <div>
                            <label className="label">Client / Owner ID *</label>
                            <input className="input" placeholder="Discord ID or owner identifier" value={form.buyerID} onChange={set("buyerID")} required />
                        </div>
                        <div>
                            <label className="label">Project ID *</label>
                            <input className="input" placeholder="my-project" value={form.botID} onChange={set("botID")} required pattern="[a-zA-Z0-9_-]+" title="Letters, numbers, hyphens, underscores only" />
                        </div>
                    </div>

                    <div>
                        <label className="label">Display Name *</label>
                        <input className="input" placeholder="My Awesome Bot" value={form.name} onChange={set("name")} required />
                    </div>

                    {/* ── Git Fields ────────────────────────────────────── */}
                    {isGit && (
                        <div style={SECTION}>
                            <div>
                                <label className="label">Git repository URL *</label>
                                <input className="input" placeholder="https://github.com/user/repo.git" value={form.repoUrl} onChange={set("repoUrl")} required={isGit} />
                            </div>
                            <div className="grid-1-mobile" style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16 }}>
                                <div>
                                    <label className="label">Branch</label>
                                    <input className="input" placeholder="main" value={form.branch} onChange={set("branch")} />
                                </div>
                                {(!isWebsite || isFullstack) && (
                                    <div>
                                        <label className="label">Start Command</label>
                                        <input className="input mono" placeholder="npm start" value={form.startScript} onChange={set("startScript")} />
                                    </div>
                                )}
                            </div>
                            {!isStatic && (
                                <div>
                                    <label className="label">Install Command</label>
                                    <input className="input mono" placeholder="npm install --omit=dev" value={form.installCommand} onChange={set("installCommand")} />
                                    <p style={{ fontSize: 12, color: "var(--text-muted)", marginTop: 6 }}>Executed after git pull.</p>
                                </div>
                            )}
                        </div>
                    )}

                    {/* ── Local Fields ──────────────────────────────────── */}
                    {!isGit && (
                        <div style={{ padding: 20, background: "var(--bg-input)", border: "1px solid var(--border)", borderRadius: 12, display: "flex", flexDirection: "column", gap: 16 }}>
                            <div>
                                <label className="label">Absolute Path on Server *</label>
                                <input className="input mono" placeholder="/root/bots/my-project" value={form.localPath} onChange={set("localPath")} required={!isGit} />
                            </div>
                            {(!isStatic) && (
                                <div className="grid-1-mobile" style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16 }}>
                                    {(!isWebsite || isFullstack) && (
                                        <div>
                                            <label className="label">Start Command</label>
                                            <input className="input mono" placeholder="npm start" value={form.startScript} onChange={set("startScript")} />
                                        </div>
                                    )}
                                    <div>
                                        <label className="label">Install Command</label>
                                        <input className="input mono" placeholder="npm install --omit=dev" value={form.installCommand} onChange={set("installCommand")} />
                                    </div>
                                </div>
                            )}
                        </div>
                    )}

                    {/* ── Website Config ────────────────────────────────── */}
                    {isWebsite && (
                        <div style={SECTION}>
                            <h3 style={SECTION_TITLE}>Website configuration</h3>

                            <div className="grid-1-mobile" style={{ display: "grid", gridTemplateColumns: isFullstack ? "1fr 1fr" : "1fr", gap: 16 }}>
                                <div>
                                    <label className="label">Public Port</label>
                                    <input className="input mono" placeholder="Auto-assign" value={form.websitePort} onChange={set("websitePort")} type="number" min="1" max="65535" />
                                    <p style={{ fontSize: 12, color: "var(--text-muted)", marginTop: 6 }}>Leave blank to auto-assign a free port. UFW will be opened automatically.</p>
                                </div>
                                {isFullstack && (
                                    <div>
                                        <label className="label">API Port (PM2) *</label>
                                        <input className="input mono" placeholder="e.g. 4000" value={form.websiteApiPort} onChange={set("websiteApiPort")} type="number" min="1" max="65535" required={isFullstack} />
                                        <p style={{ fontSize: 12, color: "var(--text-muted)", marginTop: 6 }}>Port your API server listens on internally.</p>
                                    </div>
                                )}
                            </div>

                            <div className="grid-1-mobile" style={{ display: "grid", gridTemplateColumns: isStatic ? "1fr" : "1fr 1fr", gap: 16 }}>
                                {!isStatic && (
                                    <div>
                                        <label className="label">Build Command</label>
                                        <input className="input mono" placeholder="npm run build" value={form.buildCommand} onChange={set("buildCommand")} />
                                    </div>
                                )}
                                <div>
                                    <label className="label">Dist Folder</label>
                                    <input className="input mono" placeholder={isStatic ? "." : "dist"} value={form.distFolder} onChange={set("distFolder")} />
                                    <p style={{ fontSize: 12, color: "var(--text-muted)", marginTop: 6 }}>
                                        {isStatic
                                            ? 'Folder nginx serves. Use "." for the project root.'
                                            : "Relative to project root or absolute path."}
                                    </p>
                                </div>
                            </div>

                            {isFullstack && (
                                <div>
                                    <label className="label">Start Command (API Server) *</label>
                                    <input className="input mono" placeholder="node server.js" value={form.startScript} onChange={set("startScript")} required={isFullstack} />
                                </div>
                            )}
                        </div>
                    )}

                    {/* ── Service Config ───────────────────────────────── */}
                    {isService && (
                        <div style={SECTION}>
                            <h3 style={SECTION_TITLE}>Service configuration</h3>
                            <div className="grid-1-mobile" style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16 }}>
                                <div>
                                    <label className="label">Service Port</label>
                                    <input className="input mono" placeholder="e.g. 2333" value={form.servicePort} onChange={set("servicePort")} type="number" min="1" max="65535" />
                                    <p style={{ fontSize: 12, color: "var(--text-muted)", marginTop: 6 }}>UFW will be opened automatically. Leave blank to skip.</p>
                                </div>
                                <div>
                                    <label className="label">Start Command</label>
                                    <input className="input mono" placeholder="java -jar lavalink.jar" value={form.startScript} onChange={set("startScript")} />
                                </div>
                            </div>
                        </div>
                    )}

                    {/* ── Meta ─────────────────────────────────────────── */}
                    <div className="grid-1-mobile" style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 16 }}>
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
                                            className={`chip${isActive ? " active" : ""}`}
                                            aria-pressed={isActive}
                                        >
                                            <span className="chip-dot" style={{ background: tag.color }} />
                                            {tag.name}
                                        </button>
                                    );
                                })}
                            </div>
                        </div>
                    )}

                    {error && <div style={{ padding: "12px 16px", borderRadius: 8, background: "var(--danger-bg)", color: "var(--danger)", border: "1px solid var(--danger-border)" }}>{error}</div>}

                    {loading && (
                        <div style={{ padding: "10px 12px", borderRadius: 8, background: "var(--bg-input)", color: "var(--text)", border: "1px solid var(--border)", display: "flex", alignItems: "center", gap: 10, fontSize: 13 }}>
                            <div style={{ width: 16, height: 16, borderRadius: "50%", border: "2px solid var(--accent-hover)", borderTopColor: "transparent", animation: "spin 1s linear infinite" }} />
                            {isStatic ? (isGit ? "Cloning repository…" : "Registering site…")
                                : isWebsite ? "Cloning, installing and building…"
                                : isService ? "Cloning and setting up service…"
                                : isGit ? "Cloning repository and installing dependencies…"
                                : "Registering instance…"}
                        </div>
                    )}

                    {/* Footer */}
                    <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, paddingTop: 16, borderTop: "1px solid var(--border)" }}>
                        <button type="button" className="btn-ghost" onClick={onClose} disabled={loading}>Cancel</button>
                        <button type="submit" className="btn-primary" disabled={loading}>
                            {loading ? "Deploying..." : deployLabel}
                        </button>
                    </div>
                </form>
            </div>
        </div>,
        document.body,
    );
}
