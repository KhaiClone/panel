import { useState, useEffect } from 'react';
import { useParams, useNavigate, useLocation } from 'react-router-dom';
import BotMetrics from "../components/BotMetrics";
import api from '../api/client';
import LogViewer from '../components/LogViewer';
import EnvEditor from '../components/EnvEditor';
import ConfirmModal from '../components/ConfirmModal';
import FileEditor from '../components/FileEditor';
import ShellTerminal from '../components/ShellTerminal';
import NodeVersionCard from '../components/NodeVersionCard';
import { useData } from '../context/DataContext';
import { Icon, Notice, PageHeader, StatCard, StatusBadge, StatusIcon } from '../components/ui';

// ── Helpers ────────────────────────────────────────────────────────────────
// Same words and tones as the bot cards on the Bots page (components/BotCard.jsx)
const STATUS = {
    online:    { tone: "success", label: "Online" },
    stopped:   { tone: "neutral", label: "Stopped" },
    errored:   { tone: "danger",  label: "Errored" },
    launching: { tone: "warning", label: "Starting" },
};
const getStatus = (s) => STATUS[s] ?? { tone: "neutral", label: s ?? "Unknown" };

// A small caption above a value or a sub-section
const CAPTION = { fontSize: 12, fontWeight: 500, color: "var(--text-muted)", margin: "0 0 4px" };
const SUBHEAD = { fontSize: 13, fontWeight: 600, color: "var(--text)", margin: 0 };

const fmt = (bytes) => {
    if (!bytes) return '—';
    if (bytes >= 1_073_741_824) return `${(bytes / 1_073_741_824).toFixed(1)} GB`;
    return `${(bytes / 1_048_576).toFixed(0)} MB`;
};
const fmtDate = (ts) => ts ? new Date(ts).toLocaleString() : '—';
const toLocalDatetimeInputValue = (tsMs) => {
    const d = new Date(tsMs);
    const pad = (n) => String(n).padStart(2, '0');
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + 'T' + pad(d.getHours()) + ':' + pad(d.getMinutes());
};
const formatTimeLeft = (ms) => {
    if (ms <= 0) return 'Expired';
    const d = Math.floor(ms / 86_400_000);
    const h = Math.floor((ms % 86_400_000) / 3_600_000);
    const m = Math.floor((ms % 3_600_000) / 60_000);
    if (d > 0) return `${d}d ${h}h ${m}m`;
    if (h > 0) return `${h}h ${m}m`;
    return `${m}m`;
};
const formatUptime = (pmUptime) => {
    if (!pmUptime) return '—';
    const ms = Date.now() - pmUptime;
    if (ms <= 0) return '—';
    const d = Math.floor(ms / 86_400_000);
    const h = Math.floor((ms % 86_400_000) / 3_600_000);
    const m = Math.floor((ms % 3_600_000) / 60_000);
    if (d > 0) return `${d}d ${h}h`;
    if (h > 0) return `${h}h ${m}m`;
    return `${m}m`;
};
const parseMemLimit = (s) => {
    if (!s) return null;
    const m = s.match(/^(\d+)([KMG]?)$/i);
    if (!m) return null;
    let v = parseInt(m[1], 10);
    const u = m[2].toUpperCase();
    if (u === 'K') v *= 1024;
    else if (u === 'M') v *= 1024 * 1024;
    else if (u === 'G') v *= 1024 * 1024 * 1024;
    return v > 0 ? v : null;
};

function ProgressBar({ percent, color }) {
    const pct = Math.min(Math.max(percent ?? 0, 0), 100);
    return (
        <div style={{ background: "var(--bg-input)", borderRadius: 4, height: 6, overflow: "hidden" }}>
            <div style={{ width: `${pct}%`, height: "100%", borderRadius: 4, background: color, transition: "width 0.5s cubic-bezier(0.4, 0, 0.2, 1)" }} />
        </div>
    );
}

// Inline spinner for buttons
const BtnSpinner = () => (
    <div style={{ width: 14, height: 14, borderRadius: "50%", border: "2px solid currentColor", borderTopColor: "transparent", animation: "spin 0.8s linear infinite", flexShrink: 0 }} />
);

const TABS = ['Manage', 'Resources', 'Metrics', 'Logs', 'Terminal', 'Environment', 'Files'];

// ── Website Panel ───────────────────────────────────────────────────────────
function WebsitePanel({ bot, onRefresh }) {
    const wc = bot.websiteConfig;

    // Domain / SSL state
    const [domain, setDomain] = useState(wc.domain || "");
    const [email, setEmail]   = useState("");
    const [savingDomain, setSavingDomain] = useState(false);
    const [domainMsg, setDomainMsg] = useState(null);

    // Website config edit state
    const [editingConfig, setEditingConfig] = useState(false);
    const [cfgPort, setCfgPort]             = useState(String(wc.port || ""));
    const [cfgApiPort, setCfgApiPort]       = useState(String(wc.apiPort || ""));
    const [cfgDistFolder, setCfgDistFolder] = useState(wc.distFolder || "");
    const [cfgBuildCmd, setCfgBuildCmd]     = useState(wc.buildCommand || "");
    const [savingConfig, setSavingConfig]   = useState(false);
    const [configMsg, setConfigMsg]         = useState(null);
    const [urlCopied, setUrlCopied]         = useState(false);

    // Custom nginx config state
    const [nginxExpanded, setNginxExpanded]   = useState(false);
    const [cfgNginx, setCfgNginx]             = useState(wc.extraNginxConfig || "");
    const [savingNginx, setSavingNginx]       = useState(false);
    const [nginxMsg, setNginxMsg]             = useState(null);

    const handleCopyUrl = async () => {
        try {
            if (navigator.clipboard && window.isSecureContext) {
                await navigator.clipboard.writeText(accessUrl);
            } else {
                const ta = document.createElement("textarea");
                ta.value = accessUrl;
                ta.style.position = "fixed";
                ta.style.opacity = "0";
                document.body.appendChild(ta);
                ta.focus();
                ta.select();
                document.execCommand("copy");
                document.body.removeChild(ta);
            }
            setUrlCopied(true);
            setTimeout(() => setUrlCopied(false), 2000);
        } catch {}
    };

    const accessUrl = wc.sslEnabled && wc.domain
        ? `https://${wc.domain}`
        : wc.domain
            ? `http://${wc.domain}`
            : `http://<server-ip>:${wc.port}`;

    const handleDomain = async (e) => {
        e.preventDefault();
        if (!domain.trim()) return;
        setSavingDomain(true); setDomainMsg(null);
        try {
            await api.post(`/bots/${bot._id}/domain`, { domain: domain.trim(), email: email.trim() || undefined });
            setDomainMsg({ type: "success", text: `SSL issued for ${domain.trim()}` });
            onRefresh();
        } catch (err) {
            setDomainMsg({ type: "error", text: err.response?.data?.error || "Failed to configure domain" });
        } finally { setSavingDomain(false); }
    };

    const handleSaveConfig = async (e) => {
        e.preventDefault();
        setSavingConfig(true); setConfigMsg(null);
        try {
            await api.put(`/bots/${bot._id}/website-config`, {
                port: cfgPort || undefined,
                apiPort: cfgApiPort || undefined,
                distFolder: cfgDistFolder || undefined,
                buildCommand: cfgBuildCmd,
            });
            setConfigMsg({ type: "success", text: "Website config updated — nginx reloaded." });
            setEditingConfig(false);
            onRefresh();
        } catch (err) {
            setConfigMsg({ type: "error", text: err.response?.data?.error || "Failed to update config" });
        } finally { setSavingConfig(false); }
    };

    const cancelEdit = () => {
        setCfgPort(String(wc.port || ""));
        setCfgApiPort(String(wc.apiPort || ""));
        setCfgDistFolder(wc.distFolder || "");
        setCfgBuildCmd(wc.buildCommand || "");
        setEditingConfig(false);
        setConfigMsg(null);
    };

    const handleSaveNginx = async (e) => {
        e.preventDefault();
        setSavingNginx(true); setNginxMsg(null);
        try {
            await api.put(`/bots/${bot._id}/website-config`, {
                extraNginxConfig: cfgNginx,
            });
            setNginxMsg({ type: "success", text: "Custom nginx config saved — nginx reloaded." });
            onRefresh();
        } catch (err) {
            setNginxMsg({ type: "error", text: err.response?.data?.error || "Failed to save nginx config" });
        } finally { setSavingNginx(false); }
    };

    const InfoMsg = ({ msg }) => msg ? (
        <Notice tone={msg.type === "success" ? "success" : "danger"}>{msg.text}</Notice>
    ) : null;

    return (
        <div className="card">
            {/* Header */}
            <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 20, paddingBottom: 16, borderBottom: "1px solid var(--border-light)", flexWrap: "wrap" }}>
                <Icon name="globe" style={{ color: "var(--text-dim)" }} />
                <div>
                    <h3 style={{ fontSize: 16, fontWeight: 600, color: "var(--text)", margin: 0 }}>Website</h3>
                    <p style={{ fontSize: 12, color: "var(--text-muted)", marginTop: 2 }}>
                        {wc.mode === "static" ? "Static site — served by nginx" : "Full-stack — PM2 API + nginx frontend"}
                    </p>
                </div>
                <div style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 12 }}>
                    {wc.sslEnabled && <StatusBadge tone="success">SSL active</StatusBadge>}
                    <button
                        className="btn-ghost btn-sm"
                        onClick={() => { setEditingConfig(v => !v); setConfigMsg(null); }}
                    >
                        <Icon name="pencil" size={14} />
                        Edit config
                    </button>
                </div>
            </div>

            {/* Info grid (view mode) */}
            {!editingConfig && (
                <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))", gap: 12, marginBottom: 20 }}>
                    {[
                        { label: "Public port", value: wc.port },
                        wc.mode === "fullstack" && { label: "API port", value: wc.apiPort },
                        { label: "Mode", value: wc.mode === "static" ? "Static" : "Full-stack" },
                        { label: "Dist folder", value: wc.distFolder },
                        wc.buildCommand && { label: "Build command", value: wc.buildCommand },
                        wc.domain && { label: "Domain", value: wc.domain },
                    ].filter(Boolean).map(({ label, value }) => (
                        <div key={label} style={{ background: "var(--bg-input)", border: "1px solid var(--border)", borderRadius: 8, padding: "10px 14px" }}>
                            <p style={CAPTION}>{label}</p>
                            <p className="mono" style={{ fontSize: 13, color: "var(--text)", margin: 0, wordBreak: "break-all" }}>{value}</p>
                        </div>
                    ))}
                </div>
            )}

            {/* Edit config form */}
            {editingConfig && (
                <form onSubmit={handleSaveConfig} style={{ display: "flex", flexDirection: "column", gap: 12, marginBottom: 20, padding: 16, background: "var(--bg-input)", borderRadius: 10, border: "1px solid var(--border)" }}>
                    <h4 style={SUBHEAD}>Edit website config</h4>
                    <div className="grid-1-mobile" style={{ display: "grid", gridTemplateColumns: wc.mode === "fullstack" ? "1fr 1fr" : "1fr", gap: 12 }}>
                        <div>
                            <label className="label">Public port</label>
                            <input className="input mono" type="number" min="1" max="65535" value={cfgPort} onChange={e => setCfgPort(e.target.value)} />
                            <p style={{ fontSize: 11, color: "var(--text-muted)", marginTop: 4 }}>nginx listens on this port. UFW updated automatically.</p>
                        </div>
                        {wc.mode === "fullstack" && (
                            <div>
                                <label className="label">API port (PM2)</label>
                                <input className="input mono" type="number" min="1" max="65535" value={cfgApiPort} onChange={e => setCfgApiPort(e.target.value)} />
                                <p style={{ fontSize: 11, color: "var(--text-muted)", marginTop: 4 }}>Port your backend server listens on internally.</p>
                            </div>
                        )}
                    </div>
                    <div className="grid-1-mobile" style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
                        <div>
                            <label className="label">Dist folder *</label>
                            <input className="input mono" value={cfgDistFolder} onChange={e => setCfgDistFolder(e.target.value)} required placeholder="client/dist" />
                            <p style={{ fontSize: 11, color: "var(--text-muted)", marginTop: 4 }}>Relative to project root or absolute path.</p>
                        </div>
                        <div>
                            <label className="label">Build command</label>
                            <input className="input mono" value={cfgBuildCmd} onChange={e => setCfgBuildCmd(e.target.value)} placeholder="npm run build" />
                            <p style={{ fontSize: 11, color: "var(--text-muted)", marginTop: 4 }}>Leave blank to skip build step.</p>
                        </div>
                    </div>
                    <InfoMsg msg={configMsg} />
                    <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
                        <button type="button" className="btn-ghost" onClick={cancelEdit} disabled={savingConfig}>Cancel</button>
                        <button type="submit" className="btn-primary" disabled={savingConfig}>
                            {savingConfig ? <><BtnSpinner /> Saving…</> : "Save & reload nginx"}
                        </button>
                    </div>
                </form>
            )}
            {!editingConfig && configMsg && <div style={{ marginBottom: 16 }}><InfoMsg msg={configMsg} /></div>}

            {/* Access link */}
            <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 20, padding: "8px 8px 8px 14px", background: "var(--bg-input)", border: "1px solid var(--border)", borderRadius: 8 }}>
                <span style={{ fontSize: 12, color: "var(--text-muted)", flexShrink: 0 }}>Access URL</span>
                <span className="mono" style={{ fontSize: 13, color: "var(--text)", flex: 1, wordBreak: "break-all" }}>{accessUrl}</span>
                <button onClick={handleCopyUrl} className="btn-ghost btn-sm" style={{ flexShrink: 0 }}>
                    <Icon name={urlCopied ? "check" : "copy"} size={14} /> {urlCopied ? "Copied" : "Copy"}
                </button>
            </div>

            {/* Domain / SSL form */}
            <form onSubmit={handleDomain} style={{ display: "flex", flexDirection: "column", gap: 12 }}>
                <h4 style={SUBHEAD}>
                    {wc.domain ? "Update domain & SSL" : "Add custom domain + SSL"}
                </h4>
                <div className="grid-1-mobile" style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
                    <div>
                        <label className="label">Domain *</label>
                        <input className="input mono" placeholder="example.com" value={domain} onChange={e => setDomain(e.target.value)} required />
                        <p style={{ fontSize: 11, color: "var(--text-muted)", marginTop: 4 }}>Must already point to this server's IP.</p>
                    </div>
                    <div>
                        <label className="label">Let's Encrypt email</label>
                        <input className="input mono" placeholder="admin@example.com" value={email} onChange={e => setEmail(e.target.value)} type="email" />
                        <p style={{ fontSize: 11, color: "var(--text-muted)", marginTop: 4 }}>Optional — for certificate renewal notices.</p>
                    </div>
                </div>
                <InfoMsg msg={domainMsg} />
                <div style={{ display: "flex", justifyContent: "flex-end" }}>
                    <button type="submit" className="btn-primary" disabled={savingDomain}>
                        {savingDomain ? <><BtnSpinner /> Issuing SSL…</> : <><Icon name="lock" /> Save & issue SSL</>}
                    </button>
                </div>
            </form>

            {/* Custom nginx config — only shown when domain is set (nginx mode) */}
            {wc.domain && (
                <div style={{ marginTop: 20, borderTop: "1px solid var(--border-light)", paddingTop: 16 }}>
                    <button
                        type="button"
                        onClick={() => { setNginxExpanded(v => !v); setNginxMsg(null); }}
                        style={{ display: "flex", alignItems: "center", gap: 8, background: "none", border: "none", cursor: "pointer", padding: 0, width: "100%" }}
                    >
                        <Icon name="chevronRight" size={14} style={{ color: "var(--text-muted)", transform: nginxExpanded ? "rotate(90deg)" : "none", transition: "transform 0.15s" }} />
                        <h4 style={SUBHEAD}>
                            Custom nginx config
                        </h4>
                        {wc.extraNginxConfig && <StatusBadge tone="info">Active</StatusBadge>}
                    </button>

                    {nginxExpanded && (
                        <form onSubmit={handleSaveNginx} style={{ marginTop: 12, display: "flex", flexDirection: "column", gap: 10 }}>
                            <p style={{ fontSize: 12, color: "var(--text-muted)", margin: 0 }}>
                                Extra directives injected inside the <code style={{ background: "var(--bg-input)", padding: "1px 5px", borderRadius: 4 }}>server {"{}"}</code> block — e.g. <code style={{ background: "var(--bg-input)", padding: "1px 5px", borderRadius: 4 }}>location /api {"{ proxy_pass ... }"}</code>.
                                Config is validated with <code style={{ background: "var(--bg-input)", padding: "1px 5px", borderRadius: 4 }}>nginx -t</code> before applying.
                            </p>
                            <textarea
                                className="input mono"
                                value={cfgNginx}
                                onChange={e => setCfgNginx(e.target.value)}
                                rows={8}
                                spellCheck={false}
                                placeholder={`    location /api {\n        proxy_pass http://127.0.0.1:3001;\n        proxy_http_version 1.1;\n        proxy_set_header Host $host;\n    }`}
                                style={{ resize: "vertical", fontSize: 12, lineHeight: 1.6, whiteSpace: "pre", overflowWrap: "normal", overflowX: "auto" }}
                            />
                            <InfoMsg msg={nginxMsg} />
                            <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
                                {cfgNginx.trim() && (
                                    <button type="button" className="btn-ghost btn-sm is-danger"
                                        onClick={() => { setCfgNginx(""); setNginxMsg(null); }}
                                        disabled={savingNginx}>
                                        Clear
                                    </button>
                                )}
                                <button type="submit" className="btn-primary btn-sm" disabled={savingNginx}>
                                    {savingNginx ? <><BtnSpinner /> Applying…</> : "Apply & reload nginx"}
                                </button>
                            </div>
                        </form>
                    )}
                </div>
            )}
        </div>
    );
}

export default function BotDetail() {
    const { id } = useParams();
    const navigate = useNavigate();
    const location = useLocation();
    const backPath = location.pathname.startsWith("/sites/") ? "/sites" : "/bots";
    const { groups, tags: allTags } = useData();

    const [bot, setBot]       = useState(null);
    const [loading, setLoading] = useState(true);
    const [tab, setTab]       = useState('Manage');
    const [termOpened, setTermOpened] = useState(false); // Terminal tab visited → keep its session alive
    const [busy, setBusy]     = useState(null);
    const [confirm, setConfirm] = useState(null);
    const [actionMsg, setActionMsg] = useState(null);
    const [nodes, setNodes] = useState([]);       // migration target options
    const [migrateTo, setMigrateTo] = useState(""); // selected target node id
    const [migrating, setMigrating] = useState(false);
    // Rebuild-from-git move, for when the project's node does not answer
    const [sourceOffline, setSourceOffline] = useState(false); // the server said so (SOURCE_OFFLINE)
    const [rebuildEnv, setRebuildEnv] = useState("");
    const [rebuildStart, setRebuildStart] = useState(true);

    const [editName,           setEditName]           = useState('');
    const [editExpiry,         setEditExpiry]         = useState('');
    const [editScript,         setEditScript]         = useState('');
    const [editInstallCommand, setEditInstallCommand] = useState('');
    const [editGroupId,        setEditGroupId]        = useState('');
    const [editMaxMemory,      setEditMaxMemory]      = useState('');
    const [editPrice,          setEditPrice]          = useState('');
    const [editTags,           setEditTags]           = useState([]);
    const [savingMeta,         setSavingMeta]         = useState(false);

    const fetchBot = async ({ updateForm = false } = {}) => {
        try {
            const { data } = await api.get(`/bots/${id}`);
            setBot(data);
            if (updateForm) {
                setEditName(data.name);
                setEditScript(data.startScript || 'npm start');
                setEditInstallCommand(data.installCommand || '');
                setEditGroupId(data.groupId || '');
                setEditMaxMemory(data.maxMemory || '');
                setEditPrice(data.currentPrice || '');
                setEditTags(Array.isArray(data.tags) ? data.tags : []);
                setEditExpiry(data.expiresAt ? toLocalDatetimeInputValue(data.expiresAt) : '');
            }
        } catch { navigate(backPath); }
        finally { setLoading(false); }
    };

    useEffect(() => {
        fetchBot({ updateForm: true });
        const interval = setInterval(() => fetchBot(), 8_000);
        return () => clearInterval(interval);
    }, [id]);

    const runAction = async (name, endpoint, method = 'post') => {
        setBusy(name); setActionMsg(null);
        try {
            const { data } = await api[method](`/bots/${id}/${endpoint}`);
            if (data.pullFailed) {
                setActionMsg({ type: 'error', text: `Git pull failed: ${data.pullOutput}` });
            } else {
                setActionMsg({ type: 'success', text: data.message || `${name} successful` });
            }
            fetchBot();
        } catch (err) {
            setActionMsg({ type: 'error', text: err.response?.data?.error || `${name} failed` });
        } finally { setBusy(null); }
    };

    // Migration target list (admin sees the node picker in Settings)
    useEffect(() => {
        api.get("/nodes").then((r) => setNodes(r.data)).catch(() => {});
    }, []);

    const handleMigrate = async ({ force = false } = {}) => {
        if (!migrateTo) return;
        setConfirm(null);
        setMigrating(true);
        setActionMsg({ type: "info", text: force
            ? "Rebuilding from git on the new node… cloning and installing can take a few minutes — do not close the page."
            : "Migrating… this can take a minute — do not close the page." });
        try {
            const body = force
                ? { targetNodeId: migrateTo, force: true, env: rebuildEnv, start: rebuildStart }
                : { targetNodeId: migrateTo };
            const { data } = await api.post(`/bots/${id}/migrate`, body, { timeout: 900_000 });
            setActionMsg({ type: data.startError ? "error" : "success", text: data.message || "Migration complete" });
            setMigrateTo("");
            setSourceOffline(false);
            setRebuildEnv("");
            fetchBot();
        } catch (err) {
            // The node went down after this page last looked — switch the card to the rebuild.
            if (err.response?.data?.code === "SOURCE_OFFLINE") setSourceOffline(true);
            setActionMsg({ type: "error", text: err.response?.data?.error || "Migration failed" });
        } finally { setMigrating(false); }
    };

    const handleDelete = async () => {
        setConfirm(null); setBusy('delete');
        try { await api.delete(`/bots/${id}`); navigate(backPath); }
        catch (err) { setActionMsg({ type: 'error', text: err.response?.data?.error || 'Delete failed' }); setBusy(null); }
    };

    const saveMeta = async () => {
        setSavingMeta(true);
        try {
            await api.put(`/bots/${id}`, {
                name: editName, startScript: editScript,
                installCommand: editInstallCommand || null,
                groupId: editGroupId || null, maxMemory: editMaxMemory || null,
                currentPrice: editPrice ? Number(editPrice) : null,
                tags: editTags,
                expiresAt: editExpiry ? new Date(editExpiry).toISOString() : null,
            });
            setActionMsg({ type: 'success', text: 'Settings saved' });
            fetchBot({ updateForm: true });
        } catch (err) {
            setActionMsg({ type: 'error', text: err.response?.data?.error || 'Save failed' });
        } finally { setSavingMeta(false); }
    };

    if (loading || !bot) {
        return (
            <div style={{ display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", height: "100%", gap: 16 }}>
                <div style={{ width: 48, height: 48, borderRadius: "50%", border: "4px solid var(--border)", borderTopColor: "var(--accent)", animation: "spin 1s linear infinite" }}/>
                <p style={{ fontSize: 14, color: "var(--text-muted)", fontWeight: 500 }}>Initializing environment…</p>
            </div>
        );
    }

    const isOnline     = bot.live?.status === 'online';
    const isStopped    = !isOnline;
    const isLocal      = bot.source === 'local';
    const msLeft       = bot.expiresAt ? bot.expiresAt - Date.now() : null;
    const currentGroup = groups.find(g => g._id === bot.groupId);
    const botTags      = (bot.tags || []).map(tagId => allTags.find(t => t._id === tagId)).filter(Boolean);
    const cpuPct       = parseFloat((bot.live?.cpu ?? 0).toFixed(1));
    const memLimitBytes = parseMemLimit(bot.maxMemory);
    const activeMemLimitBytes = memLimitBytes || (1024 * 1024 * 1024); // 1GB fallback
    const memPercent   = bot.live?.memory ? parseFloat(((bot.live.memory / activeMemLimitBytes) * 100).toFixed(1)) : 0;
    const s            = getStatus(bot.live?.status);

    const toggleEditTag = (tagId) => setEditTags(prev => prev.includes(tagId) ? prev.filter(t => t !== tagId) : [...prev, tagId]);

    return (
        <div className="fade-in page" style={{ maxWidth: 1200 }}>
            
            {/* Action message */}
            {actionMsg && (
                <div className="slide-up" style={{ marginBottom: 20 }}>
                    <Notice tone={actionMsg.type === 'success' ? 'success' : actionMsg.type === 'info' ? 'info' : 'danger'}>
                        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
                            <span style={{ flex: 1, minWidth: 0 }}>{actionMsg.text}</span>
                            <button onClick={() => setActionMsg(null)} className="btn-ghost btn-icon btn-sm" style={{ border: "none", margin: "-4px -6px -4px 0" }} title="Dismiss">
                                <Icon name="x" size={14} />
                            </button>
                        </div>
                    </Notice>
                </div>
            )}

            {/* Header */}
            <div style={{ display: "flex", alignItems: "flex-start", gap: 12, marginBottom: 20 }}>
                <button onClick={() => navigate(backPath)} className="btn-ghost btn-icon" title="Back" style={{ marginTop: 1 }}>
                    <Icon name="chevronLeft" />
                </button>
                <div className="min-w-0" style={{ flex: 1 }}>
                    <PageHeader
                        title={bot.name}
                        description={<span className="mono" style={{ color: "var(--text-dim)" }}>{bot.buyerID} / {bot.botID}</span>}
                        actions={<StatusBadge tone={s.tone}>{s.label}</StatusBadge>}
                    />
                    {(isLocal || bot.nodeName || currentGroup || botTags.length > 0) && (
                        <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap", marginTop: 10 }}>
                            {isLocal && (
                                <span className="badge" style={{ background: "var(--bg-input)", border: "1px solid var(--border)", color: "var(--text-muted)" }}>
                                    <Icon name="folder" size={12} /> Local
                                </span>
                            )}
                            {bot.nodeName && (
                                <span className="badge" title={`Running on node "${bot.nodeName}"`} style={{ background: "var(--bg-input)", border: "1px solid var(--border)", color: "var(--text-muted)" }}>
                                    <Icon name="node" size={12} /> {bot.nodeName}
                                </span>
                            )}
                            {currentGroup && (
                                <span className="badge" title="Group" style={{ background: "var(--bg-input)", border: "1px solid var(--border)", color: "var(--text-muted)" }}>
                                    <span className="chip-dot" style={{ background: currentGroup.color }} />
                                    {currentGroup.name}
                                </span>
                            )}
                            {botTags.map(tag => (
                                <span key={tag._id} className="badge" style={{ background: "var(--bg-input)", border: "1px solid var(--border)", color: "var(--text-muted)" }}>
                                    <span className="chip-dot" style={{ background: tag.color }} />
                                    {tag.name}
                                </span>
                            ))}
                        </div>
                    )}
                </div>
            </div>

            {/* Summary stats */}
            <div className="stat-grid" style={{ marginBottom: 24 }}>
                <StatCard label="CPU usage" value={`${bot.live?.cpu ?? 0}%`} />
                <StatCard label="Memory" value={fmt(bot.live?.memory)} />
                <StatCard label="Uptime" value={isOnline ? formatUptime(bot.live?.uptime) : "—"} />
                <StatCard label="Restarts" value={bot.live?.restarts ?? 0} />
                <StatCard
                    label="Time left"
                    value={msLeft !== null ? formatTimeLeft(msLeft) : "∞"}
                    tone={msLeft !== null && msLeft < 3 * 86_400_000 ? "danger" : undefined}
                />
            </div>

            {/* Tabs */}
            <div className="tab-bar" style={{ marginBottom: 24, display: "inline-flex", maxWidth: "100%" }}>
                {TABS.map(t => (
                    <button key={t} className={`tab-item ${tab === t ? 'active' : ''}`} onClick={() => { setTab(t); if (t === 'Terminal') setTermOpened(true); }}>
                        {t}
                    </button>
                ))}
            </div>

            <div className="slide-up">
                {/* ── Manage Tab (Controls + Settings merged) ── */}
                {tab === 'Manage' && (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 24 }}>

                        {/* Section 1: Runtime Controls + Metadata side by side */}
                        <div className="grid-1-mobile" style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 24, alignItems: "start" }}>
                            {/* Runtime Controls card */}
                            <div className="card">
                                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 20, paddingBottom: 16, borderBottom: "1px solid var(--border-light)" }}>
                                    <div>
                                        <h2 style={{ fontSize: 16, fontWeight: 600, color: "var(--text)", margin: 0 }}>Runtime controls</h2>
                                        <p style={{ fontSize: 13, color: "var(--text-muted)", marginTop: 4 }}>Manage the PM2 instance lifecycle</p>
                                    </div>
                                    <span className="mono badge" style={{ background: "var(--bg-input)", color: "var(--text-dim)", border: "1px solid var(--border)" }}>
                                        {bot.pm2Name}
                                    </span>
                                </div>
                                
                                <div className="grid-1-mobile" style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
                                    {isStopped && (
                                        <button className="btn-success" style={{ padding: "9px 14px" }} disabled={!!busy} onClick={() => runAction('start', 'start')}>
                                            {busy === 'start' ? (
                                                <><BtnSpinner /> Starting…</>
                                            ) : (
                                                <><Icon name="play" size={14} /> Start instance</>
                                            )}
                                        </button>
                                    )}
                                    {isOnline && (
                                        <button className="btn-danger" style={{ padding: "9px 14px" }} disabled={!!busy} onClick={() => runAction('stop', 'stop')}>
                                            {busy === 'stop' ? (
                                                <><BtnSpinner /> Stopping…</>
                                            ) : (
                                                <><Icon name="stop" size={14} /> Stop instance</>
                                            )}
                                        </button>
                                    )}
                                    <button className="btn-warning" style={{ padding: "9px 14px" }} disabled={!!busy} onClick={() => runAction('restart', 'restart')}>
                                        {busy === 'restart' ? (
                                            <><BtnSpinner /> Restarting…</>
                                        ) : (
                                            <><Icon name="restart" size={14} /> Restart instance</>
                                        )}
                                    </button>
                                    <button className="btn-primary" style={{ padding: "9px 14px", gridColumn: "1 / -1" }} disabled={!!busy} onClick={() => setConfirm({ action: 'update' })}>
                                        {busy === 'update' ? (
                                            <><BtnSpinner /> Processing…</>
                                        ) : isLocal ? (
                                            <><Icon name="upload" size={14} /> Rebuild from local</>
                                        ) : (
                                            <><Icon name="download" size={14} /> Pull &amp; update from Git</>
                                        )}
                                    </button>
                                </div>
                            </div>

                            {/* Instance Metadata card */}
                            <div className="card">
                                <h3 style={{ fontSize: 16, fontWeight: 600, color: "var(--text)", marginBottom: 20, paddingBottom: 16, borderBottom: "1px solid var(--border-light)" }}>
                                    Instance metadata
                                </h3>
                                <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
                                    {[
                                        { label: 'Source',          value: isLocal ? `Local: ${bot.localPath}` : bot.repoUrl },
                                        { label: 'Branch',          value: bot.branch || 'main' },
                                        { label: 'Start command',   value: bot.startScript },
                                        { label: 'Install command', value: bot.installCommand || '—' },
                                        { label: 'Node.js',         value: bot.nodeVersion ? `v${bot.nodeVersion}` : 'System default' },
                                        { label: 'Memory limit',    value: bot.maxMemory || 'Unrestricted' },
                                        { label: 'Created',         value: fmtDate(bot.createdAt) },
                                        { label: 'Expires',         value: bot.expiresAt ? fmtDate(bot.expiresAt) : 'Permanent' },
                                    ].map(({ label, value }) => (
                                        <div key={label} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12 }}>
                                            <span style={{ fontSize: 13, fontWeight: 500, color: "var(--text-muted)", flexShrink: 0 }}>{label}</span>
                                            <span className="mono" style={{ fontSize: 13, color: "var(--text)", textAlign: "right", wordBreak: "break-all" }}>{value}</span>
                                        </div>
                                    ))}
                                </div>
                            </div>
                        </div>

                        {/* ── Website Info Panel ───────────────────────── */}
                        {bot.projectType === 'website' && bot.websiteConfig && (
                            <WebsitePanel bot={bot} onRefresh={fetchBot} />
                        )}

                        {/* Divider */}
                        <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
                            <div style={{ flex: 1, height: 1, background: "var(--border-light)" }} />
                            <h3 className="section-title" style={{ margin: 0, whiteSpace: "nowrap" }}>Configuration</h3>
                            <div style={{ flex: 1, height: 1, background: "var(--border-light)" }} />
                        </div>

                        {/* Section 2: Configuration form */}
                        <div className="card">
                            <div className="grid-1-mobile" style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 32, marginBottom: 32 }}>
                                <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
                                    <div>
                                        <label className="label">Instance name</label>
                                        <input className="input" value={editName} onChange={e => setEditName(e.target.value)} />
                                    </div>
                                    <div>
                                        <label className="label">Start command</label>
                                        <input className="input mono" value={editScript} onChange={e => setEditScript(e.target.value)} />
                                        <p style={{ fontSize: 12, color: "var(--text-muted)", marginTop: 6 }}>Supports sudo, e.g. <span className="mono">sudo java -jar app.jar</span></p>
                                    </div>
                                    <div>
                                        <label className="label">Install command</label>
                                        <input className="input mono" placeholder="Leave empty to skip" value={editInstallCommand} onChange={e => setEditInstallCommand(e.target.value)} />
                                        <p style={{ fontSize: 12, color: "var(--text-muted)", marginTop: 6 }}>Executed during rebuild or git pull.</p>
                                    </div>
                                    <div>
                                        <label className="label">Group</label>
                                        <select className="input" value={editGroupId} onChange={e => setEditGroupId(e.target.value)}>
                                            <option value="">Ungrouped</option>
                                            {groups.map(g => <option key={g._id} value={g._id}>{g.name}</option>)}
                                        </select>
                                    </div>
                                    {allTags.length > 0 && (
                                        <div>
                                            <label className="label">Tags</label>
                                            <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginTop: 8 }}>
                                                {allTags.map(tag => {
                                                    const isActive = editTags.includes(tag._id);
                                                    return (
                                                        <button
                                                            key={tag._id} type="button" onClick={() => toggleEditTag(tag._id)}
                                                            className={`chip${isActive ? " active" : ""}`}
                                                            aria-pressed={isActive}
                                                        >
                                                            <span className="chip-dot" style={{ background: isActive ? tag.color : "var(--text-dim)" }} />
                                                            {tag.name}
                                                        </button>
                                                    );
                                                })}
                                            </div>
                                        </div>
                                    )}
                                </div>

                                <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
                                    <div className="grid-1-mobile" style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16 }}>
                                        <div>
                                            <label className="label">Memory limit</label>
                                            <input className="input mono" placeholder="e.g. 500M, 1G" value={editMaxMemory} onChange={e => setEditMaxMemory(e.target.value)} />
                                        </div>
                                        <div>
                                            <label className="label">Monthly price (VND)</label>
                                            <input type="number" className="input mono" placeholder="e.g. 50000" value={editPrice} onChange={e => setEditPrice(e.target.value)} disabled={!editMaxMemory} />
                                        </div>
                                    </div>
                                    <div>
                                        <label className="label">Subscription expiration</label>
                                        <input type="datetime-local" className="input" value={editExpiry} onChange={e => setEditExpiry(e.target.value)} />
                                    </div>
                                    
                                    <div style={{ marginTop: "auto", background: "var(--bg-input)", padding: 16, borderRadius: 8, border: "1px solid var(--border)" }}>
                                        <h4 style={{ fontSize: 13, fontWeight: 600, color: "var(--text)", marginBottom: 8 }}>Need help?</h4>
                                        <p style={{ fontSize: 12, color: "var(--text-muted)", lineHeight: 1.5 }}>
                                            Make sure the memory limit uses correct suffixes (K, M, G). The start command will be executed from the root of your project directory.
                                        </p>
                                    </div>
                                </div>
                            </div>

                            <div style={{ display: "flex", alignItems: "center", gap: 16, paddingTop: 20, borderTop: "1px solid var(--border-light)" }}>
                                <button className="btn-primary" onClick={saveMeta} disabled={savingMeta}>
                                    {savingMeta ? (
                                        <><BtnSpinner /> Saving…</>
                                    ) : (
                                        <><Icon name="check" /> Save configuration</>
                                    )}
                                </button>
                                {isLocal && (
                                    <p style={{ fontSize: 13, color: "var(--text-muted)", display: "flex", alignItems: "center", gap: 6 }}>
                                        <Icon name="info" size={14} />
                                        Local directory mapping — source code persists even if instance is deleted.
                                    </p>
                                )}
                            </div>
                        </div>

                        {/* Node.js version — its own card: applying it downloads and restarts */}
                        <NodeVersionCard bot={bot} onSaved={() => fetchBot()} onMessage={setActionMsg} />

                        {/* Move to another node (admin — /nodes returns [] for non-admins) */}
                        {(() => {
                            const currentNodeId = bot.nodeId;
                            const targets = nodes.filter((n) => n._id !== currentNodeId && n.status === "online" && n.enabled !== false);
                            if (nodes.length < 2) return null;
                            const hasDomain = bot.projectType === "website" && bot.websiteConfig?.domain;
                            // The copy needs the current node to answer; without it the
                            // only way off is a fresh clone of the repo on the target.
                            const rebuild = sourceOffline || bot.live?.status === "node-offline";
                            const domainNote = hasDomain && <><br /><span style={{ color: "var(--warning)" }}><StatusIcon tone="warning" size={13} /> This site has a domain — after moving, repoint its DNS A record to the new node's IP.</span></>;
                            return (
                                <div style={{ padding: 20, borderRadius: 10, background: "var(--bg-input)", border: `1px solid ${rebuild ? "var(--danger-border)" : "var(--border)"}` }}>
                                    <h3 style={{ ...SUBHEAD, margin: "0 0 6px" }}>Move to another node</h3>
                                    {!rebuild ? (
                                        <p style={{ fontSize: 12.5, color: "var(--text-dim)", margin: "0 0 14px", lineHeight: 1.5 }}>
                                            Transfers all files (data, <span className="mono">.env</span>, git history) to the target node and restarts there. The project is briefly offline during the move.
                                            {domainNote}
                                        </p>
                                    ) : !bot.repoUrl ? (
                                        <p style={{ fontSize: 12.5, color: "var(--text-dim)", margin: 0, lineHeight: 1.5 }}>
                                            <span style={{ color: "var(--danger)" }}>Node "{bot.nodeName}" is offline</span>, so this project's files cannot be copied — and it has no git repository to rebuild it from. Its files exist only on that machine: bring the node back to move it.
                                        </p>
                                    ) : (
                                        <>
                                            <p style={{ fontSize: 12.5, color: "var(--text-dim)", margin: "0 0 10px", lineHeight: 1.5 }}>
                                                <span style={{ color: "var(--danger)" }}>Node "{bot.nodeName}" is offline</span>, so its files cannot be copied. The project can be <b>rebuilt from git</b> on another node instead: a fresh clone of <span className="mono">{bot.repoUrl}</span> (<span className="mono">{bot.branch || "main"}</span>), then install and start.
                                                <br />Only what is in git comes along. The <span className="mono">.env</span>, databases, uploads and anything else the project wrote to disk stay on the offline node.
                                                {domainNote}
                                            </p>
                                            <label style={{ display: "block", fontSize: 11.5, fontWeight: 600, color: "var(--text-muted)", margin: "0 0 6px" }}>.env for the new copy (optional, can also be set later in the Environment tab)</label>
                                            <textarea
                                                className="input mono"
                                                style={{ height: 110, resize: "vertical", fontSize: 12, marginBottom: 10 }}
                                                placeholder={"TOKEN=...\nMONGO_URI=..."}
                                                value={rebuildEnv}
                                                onChange={(e) => setRebuildEnv(e.target.value)}
                                                disabled={migrating}
                                                spellCheck={false}
                                            />
                                            <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12.5, color: "var(--text-muted)", margin: "0 0 14px", cursor: "pointer" }}>
                                                <input type="checkbox" checked={rebuildStart} onChange={(e) => setRebuildStart(e.target.checked)} disabled={migrating} />
                                                Start it on the new node right away
                                            </label>
                                        </>
                                    )}
                                    {(!rebuild || bot.repoUrl) && (
                                    <div className="mobile-stack" style={{ display: "flex", gap: 10, alignItems: "center" }}>
                                        <select className="input" style={{ maxWidth: 260 }} value={migrateTo} onChange={(e) => setMigrateTo(e.target.value)} disabled={migrating}>
                                            <option value="">Select target node…</option>
                                            {targets.map((n) => (
                                                <option key={n._id} value={n._id}>{n.name}{n.local ? " (panel VPS)" : ""}</option>
                                            ))}
                                        </select>
                                        <button
                                            className={rebuild ? "btn-danger" : "btn-primary"}
                                            disabled={!migrateTo || migrating}
                                            onClick={() => setConfirm({ action: rebuild ? "rebuild" : "migrate" })}
                                        >
                                            {migrating ? <><BtnSpinner /> {rebuild ? "Rebuilding…" : "Migrating…"}</> : rebuild ? "Rebuild there" : "Migrate"}
                                        </button>
                                    </div>
                                    )}
                                    {(!rebuild || bot.repoUrl) && targets.length === 0 && (
                                        <p style={{ fontSize: 11.5, color: "var(--text-dim)", margin: "10px 0 0" }}>No other online node available to move to.</p>
                                    )}
                                </div>
                            );
                        })()}

                        {/* Danger Zone */}
                        <div style={{ padding: 20, borderRadius: 10, background: 'var(--danger-bg)', border: '1px solid var(--danger-border)' }}>
                            <h3 style={{ ...SUBHEAD, color: 'var(--danger)', margin: '0 0 12px' }}>Danger zone</h3>
                            <button
                                className="btn-danger"
                                disabled={!!busy}
                                onClick={() => setConfirm({ action: 'delete' })}
                            >
                                <Icon name="trash" />
                                Delete instance
                            </button>
                        </div>
                    </div>
                )}

                {/* Resources Tab */}
                {tab === 'Resources' && (
                    <div style={{ display: "flex", flexDirection: "column", gap: 24 }}>
                        <div className="card grid-1-mobile" style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 24 }}>
                            <div style={{ display: "flex", flexDirection: "column", alignItems: "center", textAlign: "center" }}>
                                <p style={{ ...CAPTION, marginBottom: 12 }}>Current status</p>
                                <span style={{ fontSize: 20, fontWeight: 600, display: "inline-flex", alignItems: "center", gap: 8 }}>
                                    <span className="status-dot" style={{ background: `var(--${s.tone === "neutral" ? "text-dim" : s.tone})` }} />
                                    {s.label}
                                </span>
                            </div>
                            <div style={{ borderLeft: "1px solid var(--border-light)", display: "flex", flexDirection: "column", alignItems: "center", textAlign: "center" }}>
                                <p style={{ ...CAPTION, marginBottom: 12 }}>Uptime</p>
                                <p style={{ fontSize: 20, fontWeight: 600, color: "var(--text)" }}>{isOnline ? formatUptime(bot.live?.uptime) : '—'}</p>
                            </div>
                            <div style={{ borderLeft: "1px solid var(--border-light)", display: "flex", flexDirection: "column", alignItems: "center", textAlign: "center" }}>
                                <p style={{ ...CAPTION, marginBottom: 12 }}>Process restarts</p>
                                <p style={{ fontSize: 20, fontWeight: 600, color: "var(--text)" }}>{bot.live?.restarts ?? 0}</p>
                            </div>
                        </div>

                        <div className="card">
                            <h2 style={{ fontSize: 16, fontWeight: 600, color: "var(--text)", marginBottom: 24, paddingBottom: 16, borderBottom: "1px solid var(--border-light)" }}>
                                Live hardware metrics
                            </h2>
                            <div style={{ display: "flex", flexDirection: "column", gap: 32 }}>
                                {/* CPU */}
                                <div>
                                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
                                        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                                            <span style={{ padding: 6, background: "var(--bg-input)", border: "1px solid var(--border)", borderRadius: 6, display: "flex", alignItems: "center", color: "var(--text-muted)" }}><Icon name="cpu" /></span>
                                            <span style={{ fontSize: 14, fontWeight: 600, color: "var(--text)" }}>CPU utilization</span>
                                        </div>
                                        <span className="mono" style={{ fontSize: 15, fontWeight: 600, color: cpuPct > 80 ? "var(--danger)" : cpuPct > 50 ? "var(--warning)" : "var(--success)" }}>
                                            {cpuPct}%
                                        </span>
                                    </div>
                                    <ProgressBar percent={cpuPct} color={cpuPct > 80 ? "var(--danger)" : cpuPct > 50 ? "var(--warning)" : "var(--success)"} />
                                </div>
                                {/* Memory */}
                                <div>
                                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
                                        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                                            <span style={{ padding: 6, background: "var(--bg-input)", border: "1px solid var(--border)", borderRadius: 6, display: "flex", alignItems: "center", color: "var(--text-muted)" }}><Icon name="memory" /></span>
                                            <span style={{ fontSize: 14, fontWeight: 600, color: "var(--text)" }}>Memory utilization</span>
                                        </div>
                                        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                                            <span className="mono" style={{ fontSize: 13, color: "var(--text-muted)", marginTop: 2 }}>
                                                ({memPercent}%)
                                            </span>
                                            <span className="mono" style={{ fontSize: 15, fontWeight: 600, color: memPercent > 80 ? "var(--danger)" : "var(--text)" }}>
                                                {fmt(bot.live?.memory)}{memLimitBytes ? ` / ${fmt(memLimitBytes)}` : " / 1.00 GB"}
                                            </span>
                                        </div>
                                    </div>
                                    <ProgressBar percent={memPercent} color={memPercent > 85 ? "var(--danger)" : "var(--info)"} />
                                    {memLimitBytes && memPercent >= 80 && (
                                        <div style={{ marginTop: 12 }}>
                                            <Notice tone="danger">Memory critical at {memPercent}%. PM2 should restart the process if it hits 100%.</Notice>
                                        </div>
                                    )}
                                </div>
                            </div>
                        </div>
                    </div>
                )}

                {/* Metrics Tab — this project's own CPU/memory history */}
                {tab === 'Metrics' && (
                    <BotMetrics botId={bot._id} maxMemory={bot.maxMemory} />
                )}

                {/* Logs Tab */}
                {tab === 'Logs' && (
                    <div style={{ borderRadius: 10, overflow: "hidden", border: "1px solid var(--border)", background: "var(--bg-base)" }}>
                        <LogViewer botId={id} />
                    </div>
                )}

                {/* Terminal Tab — a shell already in this project's folder on its
                    node. Mounted on first visit and only hidden after that, so
                    looking at Logs or Files does not kill the session. */}
                {termOpened && (
                    <div className="card" style={{ display: tab === 'Terminal' ? 'flex' : 'none', flexDirection: 'column', height: 640, padding: 20 }}>
                        <ShellTerminal
                            params={{ bot: id }}
                            targetLabel={bot.name}
                            title={
                                <div>
                                    <div style={{ fontSize: 14, fontWeight: 600, color: "var(--text)" }}>Terminal</div>
                                    <div className="mono" style={{ fontSize: 12, color: "var(--text-muted)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                                        {isLocal ? bot.localPath : `${bot.buyerID}/${bot.botID}`}{bot.nodeName ? ` · ${bot.nodeName}` : ''}
                                    </div>
                                </div>
                            }
                        />
                    </div>
                )}

                {/* Environment Tab */}
                {tab === 'Environment' && (
                    <div className="card" style={{ padding: 0, overflow: "hidden" }}>
                        <EnvEditor botId={id} />
                    </div>
                )}

                {/* Files Tab */}
                {tab === 'Files' && (
                    <div className="card" style={{ padding: 0, overflow: "hidden" }}>
                        <FileEditor botId={id} />
                    </div>
                )}
            </div>

            {/* Modals */}
            {confirm?.action === 'update' && (
                <ConfirmModal
                    title={isLocal ? 'Rebuild local instance?' : 'Synchronize Git repository?'}
                    message={`${isLocal ? 'Execute the install command' : 'Pull latest changes and reinstall dependencies'}. A running instance is restarted; a stopped one stays stopped.`}
                    confirmText="Continue update" danger={false}
                    onConfirm={() => { setConfirm(null); runAction('update', 'update'); }}
                    onCancel={() => setConfirm(null)}
                />
            )}
            {confirm?.action === 'migrate' && (
                <ConfirmModal
                    title={`Move "${bot.name}" to ${nodes.find(n => n._id === migrateTo)?.name || "another node"}?`}
                    message={"The project will be stopped on its current node, transferred with all its data, and started on the target. It will be briefly offline.\n\nThe source copy is removed once the target is confirmed running."}
                    confirmText="Migrate now" danger={false}
                    onConfirm={() => handleMigrate()}
                    onCancel={() => setConfirm(null)}
                />
            )}
            {confirm?.action === 'rebuild' && (
                <ConfirmModal
                    title={`Rebuild "${bot.name}" on ${nodes.find(n => n._id === migrateTo)?.name || "another node"}?`}
                    message={
                        `Its git repo is cloned fresh there${rebuildEnv.trim() ? " with the .env you pasted" : " with NO .env"}, then installed${rebuildStart ? " and started" : ""}. Files that are not in git stay on "${bot.nodeName}".\n\n` +
                        `If that machine is in fact still running (only its agent is down), the old copy keeps running too until the node answers again — the panel then stops it automatically and keeps its files.\n\n` +
                        `If you remove the node before it answers, stop the old copy on that machine yourself: pm2 delete ${bot.pm2Name} && pm2 save`
                    }
                    confirmText="Rebuild now"
                    onConfirm={() => handleMigrate({ force: true })}
                    onCancel={() => setConfirm(null)}
                />
            )}
            {confirm?.action === 'delete' && (
                <ConfirmModal
                    title={`Terminate "${bot.name}"?`}
                    message={isLocal
                        ? "This will stop the PM2 process and remove the instance from the panel.\n\nYour project folder will NOT be deleted."
                        : "This will stop the PM2 process, remove the instance, and delete the project folder from disk.\n\nThis action is irreversible."}
                    confirmText={isLocal ? "Remove from panel" : "Delete everything"}
                    onConfirm={handleDelete}
                    onCancel={() => setConfirm(null)}
                />
            )}
        </div>
    );
}
